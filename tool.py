from __future__ import annotations

import os
import re
import json
import shutil
import threading
import pathlib
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_core.documents import Document

from langchain_openai import AzureOpenAIEmbeddings

DEBUG = True


def debug_print(msg: str) -> None:
    if DEBUG:
        print(f"[DEBUG] {msg}")


def _resolve_app_dir() -> Path:
    """Resolve project root consistently for scripts"""
    try:
        base = Path(__file__).resolve().parent
    except Exception:
        base = Path.cwd().resolve()

    override = os.getenv("PROJECT_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return base




APP_DIR = _resolve_app_dir()
SOURCE_DIR = (APP_DIR / "Database").resolve()
CHROMA_DIR = (APP_DIR / "chroma_db").resolve()
MANIFEST_PATH = (CHROMA_DIR / "manifest.json").resolve()

STATE_DIR = (APP_DIR / "runtime").resolve()
STATE_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = str((STATE_DIR / "sessions.sqlite").resolve())

SOURCE_DIR.mkdir(parents=True, exist_ok=True)
CHROMA_DIR.mkdir(parents=True, exist_ok=True)

debug_print(f"APP_DIR: {APP_DIR}")
debug_print(f"SOURCE_DIR: {SOURCE_DIR}")
debug_print(f"CHROMA_DIR: {CHROMA_DIR}")
debug_print(f"MANIFEST_PATH: {MANIFEST_PATH}")
debug_print(f"DB_PATH: {DB_PATH}")

COLLECTION_NAME = "pdf_rag"

# Chunking control 
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150

# Fallback name 
DEFAULT_EMBED_DEPLOYMENT = "text-embedding-3-small"

_VECTORSTORE: Optional[Chroma] = None
_INDEX_ERROR: Optional[str] = None

_tls = threading.local()


def _set_active_session_id(session_id: str) -> None:
    _tls.session_id = session_id


def _get_active_session_id() -> str:
    return getattr(_tls, "session_id", "tool_session")


def _looks_french(text: str) -> bool:
    return bool(
        re.search(
            r"\b(bonjour|salut|merci|comment\s+ça|comment\s+faire|comment\s+puis-je|"
            r"ça|vous|je\s+suis|je\s+m'appelle|au\s+revoir|s'il\s+vous\s+pla[iî]t)\b",
            text or "",
            re.IGNORECASE,
        )
    )


def _not_found_msg(user_text: str) -> str:
    return "Le sujet n'existe pas dans ma source de données."


def _list_pdfs(pdf_dir: Path) -> List[Path]:
    return sorted([p for p in pdf_dir.rglob("*.pdf") if p.is_file()])


def _compute_files_manifest(pdf_paths: List[Path]) -> Dict[str, float]:
    """Track PDFs by resolved path + mtime. If anything changes -> rebuild."""
    return {str(p.resolve()): p.stat().st_mtime for p in pdf_paths}


def _load_manifest() -> Optional[Dict[str, Any]]:
    if not MANIFEST_PATH.exists():
        return None
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_manifest(data: Dict[str, Any]) -> None:
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _make_embeddings() -> AzureOpenAIEmbeddings:
    """
    Build Azure OpenAI embeddings from environment variables.

    Required env:
      AZURE_OPENAI_EMBED_ENDPOINT
      AZURE_OPENAI_EMBED_API_KEY
      AZURE_OPENAI_DEPLOYMENT_EMBED

    Optional env:
      AZURE_OPENAI_EMBED_API_VERSION
    """
    embed_endpoint = os.getenv("AZURE_OPENAI_EMBED_ENDPOINT", "").strip()
    embed_key = os.getenv("AZURE_OPENAI_EMBED_API_KEY", "").strip()
    embed_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT_EMBED", DEFAULT_EMBED_DEPLOYMENT).strip()
    embed_api_version = os.getenv(
        "AZURE_OPENAI_EMBED_API_VERSION",
        os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview"),
    ).strip()

    if not embed_endpoint or not embed_key or not embed_deployment:
        raise RuntimeError(
            "Missing Azure embedding env vars. Need AZURE_OPENAI_EMBED_ENDPOINT, "
            "AZURE_OPENAI_EMBED_API_KEY, AZURE_OPENAI_DEPLOYMENT_EMBED."
        )

    return AzureOpenAIEmbeddings(
        azure_endpoint=embed_endpoint,
        api_key=embed_key,
        api_version=embed_api_version,
        azure_deployment=embed_deployment
    )


def _load_documents_from_pdfs(pdf_paths: List[Path]) -> List[Document]:
    docs: List[Document] = []
    for pdf_path in pdf_paths:
        loader = PyPDFLoader(str(pdf_path))
        loaded = loader.load()
        for d in loaded:
            d.metadata = d.metadata or {}
            d.metadata["source"] = pdf_path.name
            d.metadata["path"] = str(pdf_path.resolve())
        docs.extend(loaded)
    return docs


def _split_documents(docs: List[Document]) -> List[Document]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", " ", ""],
    )
    return splitter.split_documents(docs)


def _stable_chunk_id(doc: Document, chunk_i: int) -> str:
    src = f"{doc.metadata.get('path','')}|{doc.metadata.get('page','')}|{chunk_i}"
    return hashlib.sha1(src.encode("utf-8")).hexdigest()


def _safe_rmtree(path: Path) -> None:
    def _onerror(func, p, exc_info):
        try:
            os.chmod(p, 0o777)
            func(p)
        except Exception:
            pass

    if path.exists():
        shutil.rmtree(path, ignore_errors=False, onerror=_onerror)


def _rebuild_chroma_index(pdf_paths: List[Path]) -> Tuple[Chroma, int, int]:
    global _INDEX_ERROR

    _safe_rmtree(CHROMA_DIR)
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)

    docs = _load_documents_from_pdfs(pdf_paths)
    chunks = _split_documents(docs)

    embeddings = _make_embeddings()

    ids: List[str] = []
    for i, c in enumerate(chunks):
        ids.append(_stable_chunk_id(c, i))

    vectorstore = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings,
        persist_directory=str(CHROMA_DIR),
        collection_name=COLLECTION_NAME,
        ids=ids,
    )

    try:
        vectorstore.persist()
    except Exception:
        pass

    manifest = {
        "collection_name": COLLECTION_NAME,
        "chunk_size": CHUNK_SIZE,
        "chunk_overlap": CHUNK_OVERLAP,
        "files": _compute_files_manifest(pdf_paths),
        # Record Azure embedding deployment for debugging/auditing
        "azure_embed_deployment": os.getenv("AZURE_OPENAI_DEPLOYMENT_EMBED", DEFAULT_EMBED_DEPLOYMENT),
        "azure_embed_endpoint": os.getenv("AZURE_OPENAI_EMBED_ENDPOINT", ""),
        "azure_embed_api_version": os.getenv(
            "AZURE_OPENAI_EMBED_API_VERSION",
            os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview"),
        ),
    }
    _save_manifest(manifest)

    _INDEX_ERROR = None
    return vectorstore, len(pdf_paths), len(chunks)


def _load_existing_chroma() -> Chroma:
    embeddings = _make_embeddings()
    return Chroma(
        persist_directory=str(CHROMA_DIR),
        collection_name=COLLECTION_NAME,
        embedding_function=embeddings,
    )


def ensure_index_up_to_date() -> Tuple[Chroma, int, bool]:
    global _VECTORSTORE

    pdf_paths = _list_pdfs(SOURCE_DIR)
    if not pdf_paths:
        raise RuntimeError("No source found. Put PDFs in ./Database/ first.")

    current_files = _compute_files_manifest(pdf_paths)
    existing = _load_manifest()

    needs_rebuild = True
    if existing:
        same_settings = (
            existing.get("collection_name") == COLLECTION_NAME
            and existing.get("chunk_size") == CHUNK_SIZE
            and existing.get("chunk_overlap") == CHUNK_OVERLAP
        )
        same_files = existing.get("files") == current_files

        # If embedding deployment changed, rebuild
        existing_deploy = (existing.get("azure_embed_deployment") or "").strip()
        current_deploy = os.getenv("AZURE_OPENAI_DEPLOYMENT_EMBED", DEFAULT_EMBED_DEPLOYMENT).strip()
        same_embed = (existing_deploy == current_deploy)

        needs_rebuild = not (same_settings and same_files and same_embed)

    if needs_rebuild:
        debug_print("Index missing/outdated -> rebuilding Chroma index...")
        _VECTORSTORE, pdf_count, _chunk_count = _rebuild_chroma_index(pdf_paths)
        return _VECTORSTORE, pdf_count, True

    debug_print("Index is up-to-date -> loading existing Chroma...")
    _VECTORSTORE = _load_existing_chroma()
    return _VECTORSTORE, len(pdf_paths), False


def index_pdfs_impl() -> str:
    global _INDEX_ERROR
    try:
        _, pdf_count, rebuilt = ensure_index_up_to_date()
        if rebuilt:
            return f"Rebuilt Chroma index from {pdf_count} PDF(s) in ./Database/."
        return f"Index already up-to-date for {pdf_count} PDF(s)."
    except Exception as e:
        _INDEX_ERROR = f"{type(e).__name__}: {e}"
        return f"Indexing failed: {_INDEX_ERROR}"


def rag_search_pdfs_impl(query: str, k: int = 5) -> Dict[str, Any]:
    global _INDEX_ERROR

    if not query or not query.strip():
        return {"query": query, "results": [], "error": "Empty query"}

    try:
        vs, _, _ = ensure_index_up_to_date()
        retriever = vs.as_retriever(search_kwargs={"k": int(k)})
        docs = retriever.get_relevant_documents(query)

        results = []
        for d in docs:
            md = d.metadata or {}
            page = md.get("page", None)
            page_display = (int(page) + 1) if isinstance(page, int) else page

            results.append(
                {
                    "source": md.get("source", "unknown"),
                    "path": md.get("path", ""),
                    "page": page_display,
                    "text": d.page_content,
                }
            )

        return {"query": query, "results": results, "error": None}

    except Exception as e:
        _INDEX_ERROR = f"{type(e).__name__}: {e}"
        return {"query": query, "results": [], "error": _INDEX_ERROR}


def _format_evidence(evidence: Dict[str, Any], max_chars_per_chunk: int = 1200) -> str:
    results = evidence.get("results", [])
    if not results:
        return ""

    blocks = []
    for i, r in enumerate(results, start=1):
        txt = (r.get("text") or "").strip()
        if len(txt) > max_chars_per_chunk:
            txt = txt[:max_chars_per_chunk] + "..."

        src = r.get("source", "unknown")
        page = r.get("page", "?")

        blocks.append(
            f"EVIDENCE {i}\n"
            f"CITATION: ({src}, p. {page})\n"
            f"TEXT:\n{txt}"
        )

    return "\n\n---\n\n".join(blocks)


ChatHistory = List[Dict[str, Any]]


def _kb_markdown() -> str:
    import time

    try:
        pdfs = _list_pdfs(SOURCE_DIR)
        n = len(pdfs)
        latest = max((p.stat().st_mtime for p in pdfs), default=None)
        latest_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(latest)) if latest else "-"
        return (
            f"**Nombre de sources:** {n}\n\n"
            f"**Dernière mise à jour:** {latest_str}\n\n"
        )
    except Exception as e:
        return f"Erreur lors de la lecture des sources.\n\n`{type(e).__name__}: {e}`"


def _status_pill_text() -> str:
    if _INDEX_ERROR:
        return f"**Index status:** Erreur - `{_INDEX_ERROR}`"
    return "**Index status:** Ok"


def _reindex_and_refresh(history: ChatHistory):
    out = index_pdfs_impl()
    history = history or []
    history.append({"role": "assistant", "content": [{"type": "text", "text": out}]})
    return history, _kb_markdown(), _status_pill_text()


class PdfRagTools:
    def __init__(self, source_dir: Path, chroma_dir: Path, manifest_path: Path, debug: bool = True):
        self.source_dir = source_dir
        self.chroma_dir = chroma_dir
        self.manifest_path = manifest_path
        self.debug = debug

    def index_pdfs_impl(self) -> str:
        return index_pdfs_impl()

    def rag_search_pdfs_impl(self, query: str, k: int = 5) -> Dict[str, Any]:
        return rag_search_pdfs_impl(query, k=k)

