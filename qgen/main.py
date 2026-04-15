from __future__ import annotations

import argparse
import logging
from pathlib import Path

from qgen.allocator import allocate_questions_across_segments
from qgen.config import AppConfig, load_config
from qgen.exporter import write_outputs_for_pdf
from qgen.models import QARecord, Segment
from qgen.pdf_splitter import split_pdf_into_segments
from qgen.question_generator import build_llm_client, generate_qa_for_segment

LOGGER = logging.getLogger("qgen")


def _collect_pdf_files(documents_path: Path) -> list[Path]:
    if not documents_path.exists():
        raise FileNotFoundError(f"Documents directory not found: {documents_path}")
    return sorted([p for p in documents_path.iterdir() if p.suffix.lower() == ".pdf"])


def _supplement_rows_if_needed(
    config: AppConfig,
    records: list[QARecord],
    segments: list[Segment],
    client,
) -> list[QARecord]:
    missing = config.num_questions - len(records)
    if missing <= 0:
        return records[: config.num_questions]

    non_empty = [s for s in segments if s.text.strip()]
    if not non_empty:
        return records

    # Use combined segment context for a final attempt to hit target rows.
    combined = Segment(
        source_pdf=non_empty[0].source_pdf,
        segment_index=9999,
        page_start=non_empty[0].page_start,
        page_end=non_empty[-1].page_end,
        text="\n\n".join(s.text for s in non_empty),
    )
    try:
        extra = generate_qa_for_segment(client, config, combined, missing)
        records.extend(extra)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Supplement generation failed: %s", exc)
    return records[: config.num_questions]


def process_pdf(config: AppConfig, client, pdf_path: Path) -> tuple[Path, Path]:
    LOGGER.info("Processing %s", pdf_path.name)
    segments = split_pdf_into_segments(pdf_path, config.pages_per_segment)
    allocations = allocate_questions_across_segments(segments, config.num_questions)

    records: list[QARecord] = []
    for idx, segment in enumerate(segments):
        to_generate = allocations.get(idx, 0)
        if to_generate == 0:
            if not segment.text.strip():
                LOGGER.warning(
                    "Skipping empty segment %s pages %s-%s",
                    segment.segment_index,
                    segment.page_start,
                    segment.page_end,
                )
            continue

        segment_rows = generate_qa_for_segment(client, config, segment, to_generate)
        records.extend(segment_rows)

    records = _supplement_rows_if_needed(config, records, segments, client)
    if len(records) < config.num_questions:
        LOGGER.warning(
            "Generated %s/%s rows for %s due to low extractable content.",
            len(records),
            config.num_questions,
            pdf_path.name,
        )

    csv_path, xlsx_path = write_outputs_for_pdf(
        output_dir=config.output_path,
        pdf_stem=pdf_path.stem,
        records=records,
        include_metadata_columns=config.include_metadata_columns,
    )
    LOGGER.info("Wrote %s and %s", csv_path.name, xlsx_path.name)
    return csv_path, xlsx_path


def run(config_path: str) -> None:
    config = load_config(config_path)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    client = build_llm_client(config)
    LOGGER.info(
        "LLM provider: Gateway at %s (model=%s)",
        config.get_gateway_base_url(),
        config.get_gateway_model(),
    )
    pdf_files = _collect_pdf_files(config.documents_path)
    if not pdf_files:
        LOGGER.info("No PDFs found in %s", config.documents_path)
        return

    for pdf_path in pdf_files:
        process_pdf(config, client, pdf_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Q&A from PDFs in segments.")
    parser.add_argument(
        "--config",
        default="config.yaml",
        help="Path to YAML config file (default: config.yaml)",
    )
    args = parser.parse_args()
    run(args.config)


if __name__ == "__main__":
    main()

