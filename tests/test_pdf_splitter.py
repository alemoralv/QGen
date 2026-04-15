import pytest

from qgen import pdf_splitter
from qgen.pdf_splitter import build_segments_from_page_texts


def test_build_segments_10_page_boundaries():
    pages = [f"page {i}" for i in range(1, 26)]
    segments = build_segments_from_page_texts("a.pdf", pages, pages_per_segment=10)

    assert len(segments) == 3
    assert (segments[0].page_start, segments[0].page_end) == (1, 10)
    assert (segments[1].page_start, segments[1].page_end) == (11, 20)
    assert (segments[2].page_start, segments[2].page_end) == (21, 25)
    assert segments[0].segment_index == 0
    assert segments[2].segment_index == 2


def test_build_segments_omits_blank_page_text_from_join():
    pages = ["hello", "", "world"]
    segments = build_segments_from_page_texts("a.pdf", pages, pages_per_segment=10)
    assert len(segments) == 1
    assert segments[0].text == "hello\n\nworld"


def test_split_pdf_markdown_falls_back_to_txt(monkeypatch):
    def fail_markdown(_pdf_path):
        raise RuntimeError("md failed")

    def fake_txt(_pdf_path):
        return ["first page text", "second page text"]

    monkeypatch.setattr(pdf_splitter, "extract_page_texts_markdown", fail_markdown)
    monkeypatch.setattr(pdf_splitter, "extract_page_texts_txt", fake_txt)

    segments = pdf_splitter.split_pdf_into_segments(
        "example.pdf",
        pages_per_segment=10,
        extract_format="md",
        fallback_to_txt=True,
    )

    assert len(segments) == 1
    assert segments[0].source_pdf == "example.pdf"
    assert segments[0].text == "first page text\n\nsecond page text"


def test_split_pdf_markdown_raises_without_fallback(monkeypatch):
    def fail_markdown(_pdf_path):
        raise RuntimeError("md failed")

    monkeypatch.setattr(pdf_splitter, "extract_page_texts_markdown", fail_markdown)

    with pytest.raises(RuntimeError, match="md failed"):
        pdf_splitter.split_pdf_into_segments(
            "example.pdf",
            pages_per_segment=10,
            extract_format="md",
            fallback_to_txt=False,
        )


def test_split_pdf_txt_mode_uses_txt_extractor(monkeypatch):
    def fake_txt(_pdf_path):
        return ["txt content"]

    def fail_markdown(_pdf_path):
        raise AssertionError("markdown extractor should not be called in txt mode")

    monkeypatch.setattr(pdf_splitter, "extract_page_texts_txt", fake_txt)
    monkeypatch.setattr(pdf_splitter, "extract_page_texts_markdown", fail_markdown)

    segments = pdf_splitter.split_pdf_into_segments(
        "example.pdf",
        pages_per_segment=10,
        extract_format="txt",
    )
    assert len(segments) == 1
    assert segments[0].text == "txt content"

