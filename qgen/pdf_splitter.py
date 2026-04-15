from __future__ import annotations

import logging
import re
from pathlib import Path

from pypdf import PdfReader

from qgen.models import Segment

LOGGER = logging.getLogger("qgen")


def extract_page_texts_txt(pdf_path: str | Path) -> list[str]:
    reader = PdfReader(str(pdf_path))
    texts: list[str] = []
    for page in reader.pages:
        texts.append((page.extract_text() or "").strip())
    return texts


def _normalize_markdown(text: str) -> str:
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _coerce_markdown_pages(raw: object) -> list[str]:
    if isinstance(raw, str):
        # Some markdown extractors separate pages with form-feed.
        chunks = raw.split("\f")
        return [_normalize_markdown(chunk) for chunk in chunks]

    if isinstance(raw, list):
        pages: list[str] = []
        for item in raw:
            if isinstance(item, str):
                pages.append(_normalize_markdown(item))
                continue
            if isinstance(item, dict):
                text = (
                    item.get("text")
                    or item.get("markdown")
                    or item.get("md")
                    or ""
                )
                pages.append(_normalize_markdown(str(text)))
        return pages

    return []


def extract_page_texts_markdown(pdf_path: str | Path) -> list[str]:
    try:
        import pymupdf4llm
    except ImportError as exc:
        raise RuntimeError(
            "Markdown extraction requires pymupdf4llm. "
            "Install dependencies from requirements.txt."
        ) from exc

    try:
        raw = pymupdf4llm.to_markdown(str(pdf_path), page_chunks=True)
        pages = _coerce_markdown_pages(raw)
    except TypeError:
        # Older versions may not support page_chunks.
        raw = pymupdf4llm.to_markdown(str(pdf_path))
        pages = _coerce_markdown_pages(raw)

    if not pages:
        raise ValueError(f"No markdown content extracted from {pdf_path}")
    return pages


def build_segments_from_page_texts(
    source_pdf: str,
    page_texts: list[str],
    pages_per_segment: int,
) -> list[Segment]:
    segments: list[Segment] = []
    if pages_per_segment <= 0:
        raise ValueError("pages_per_segment must be > 0")

    for start in range(0, len(page_texts), pages_per_segment):
        end = min(start + pages_per_segment, len(page_texts))
        chunk_pages = page_texts[start:end]
        merged_text = "\n\n".join([t for t in chunk_pages if t.strip()]).strip()
        segments.append(
            Segment(
                source_pdf=source_pdf,
                segment_index=len(segments),
                page_start=start + 1,
                page_end=end,
                text=merged_text,
            )
        )
    return segments


def split_pdf_into_segments(
    pdf_path: str | Path,
    pages_per_segment: int,
    extract_format: str = "md",
    fallback_to_txt: bool = True,
) -> list[Segment]:
    path = Path(pdf_path)
    mode = extract_format.strip().lower()
    if mode == "txt":
        page_texts = extract_page_texts_txt(path)
    elif mode == "md":
        try:
            page_texts = extract_page_texts_markdown(path)
        except Exception:
            if not fallback_to_txt:
                raise
            LOGGER.warning(
                "Markdown extraction failed for %s, falling back to text extraction.",
                path.name,
                exc_info=True,
            )
            page_texts = extract_page_texts_txt(path)
    else:
        raise ValueError("extract_format must be either 'md' or 'txt'")
    return build_segments_from_page_texts(
        source_pdf=path.name,
        page_texts=page_texts,
        pages_per_segment=pages_per_segment,
    )

