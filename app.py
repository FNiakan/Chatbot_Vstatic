from __future__ import annotations

import os
import shutil
import certifi
import pathlib
import uuid
from datetime import datetime
from typing import Any

from dotenv import load_dotenv

# Load env vars before checking for Langfuse keys
load_dotenv(override=True)
import json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agents import Agent, Runner, SQLiteSession, function_tool
from agents import (
    OpenAIChatCompletionsModel,
    set_default_openai_api,
    set_default_openai_client,
    set_tracing_disabled,
)
from agents.stream_events import RawResponsesStreamEvent
# Conditional Langfuse Import
if os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"):
    try:
        from langfuse.openai import AsyncAzureOpenAI
    except ImportError:
        from openai import AsyncAzureOpenAI
else:
    from openai import AsyncAzureOpenAI

from context import chat_instruction, sys_instruction, user_instruction
from tool import (
    CHROMA_DIR,
    DB_PATH,
    MANIFEST_PATH,
    SOURCE_DIR,
    PdfRagTools,
    _format_evidence,
    _get_active_session_id,
    _kb_markdown,
    _looks_french,
    _not_found_msg,
    _set_active_session_id,
    _status_pill_text,
    debug_print,
    index_pdfs_impl,
    rag_search_pdfs_impl,
)


#  SSL setup 
CORP_PEM = "cert.pem"
corp_path = pathlib.Path(CORP_PEM).resolve()
if not corp_path.exists():
    raise RuntimeError(f"Missing certificate file: {corp_path}")

bundle_path = pathlib.Path(".certs/corp-bundle.pem")
bundle_path.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(certifi.where(), bundle_path)
with open(bundle_path, "ab") as out, open(corp_path, "rb") as add:
    out.write(b"\n")
    out.write(add.read())

CA_BUNDLE = str(bundle_path.resolve())
os.environ["SSL_CERT_FILE"] = CA_BUNDLE
os.environ["REQUESTS_CA_BUNDLE"] = CA_BUNDLE
os.environ["CURL_CA_BUNDLE"] = CA_BUNDLE
os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"
os.environ["OPENAI_AGENTS_DISABLE_TRACING"] = "1"


#  Env / model client 
#  Env / model client 
# load_dotenv(override=True)  # Moved to top

AZURE_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
AZURE_KEY = os.getenv("AZURE_OPENAI_API_KEY", "").strip()
AZURE_API_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview").strip()

if not AZURE_ENDPOINT or not AZURE_KEY:
    raise RuntimeError("Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY in .env")

azure_client = AsyncAzureOpenAI(
    api_key=AZURE_KEY,
    azure_endpoint=AZURE_ENDPOINT,
    api_version=AZURE_API_VERSION,
)

set_default_openai_api("chat_completions")
set_default_openai_client(azure_client)
set_tracing_disabled(True)


#  RAG tools 
rag = PdfRagTools(SOURCE_DIR, CHROMA_DIR, MANIFEST_PATH, debug=True)
index_pdfs_tool = function_tool(rag.index_pdfs_impl)
rag_search_pdfs_tool = function_tool(rag.rag_search_pdfs_impl)

CHAT_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT_CHAT", "gpt-4.1").strip()
QA_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT_QA", CHAT_DEPLOYMENT).strip()

QA_AGENT = Agent(
    name="QA Agent",
    instructions=sys_instruction(),
    model=OpenAIChatCompletionsModel(model=QA_DEPLOYMENT, openai_client=azure_client),
    tools=[index_pdfs_tool, rag_search_pdfs_tool],
)


async def pdf_qa(question: str, k: int = 6) -> str:
    question = (question or "").strip()
    if not question:
        return "Posez-moi une question."

    missing_msg = _not_found_msg(question)
    evidence = rag_search_pdfs_impl(question, k=k)

    if evidence.get("error"):
        return f"Désolé, je n'ai pas pu effectuer la recherche: {evidence['error']}"

    if not evidence.get("results"):
        return missing_msg

    evidence_block = _format_evidence(evidence)
    session = SQLiteSession(session_id=_get_active_session_id(), db_path=DB_PATH)

    try:
        result = await Runner.run(
            QA_AGENT,
            user_instruction(missing_msg, evidence_block, question),
            session=session,
        )
        answer = (getattr(result, "final_output", "") or "").strip()
        return answer or missing_msg
    except Exception as exc:
        debug_print(f"pdf_qa error: {type(exc).__name__}: {exc}")
        return "Désolé, une erreur est survenue pendant l'analyse de votre demande."


pdf_qa_tool = function_tool(pdf_qa)

CHAT_AGENT = Agent(
    name="Conversation Agent",
    model=OpenAIChatCompletionsModel(model=CHAT_DEPLOYMENT, openai_client=azure_client),
    tools=[pdf_qa_tool],
    instructions=chat_instruction(),
)


# API schema 
class ChatRequest(BaseModel):
    message: str = Field(min_length=1, description="Message utilisateur")
    session_id: str | None = Field(default=None, description="Identifiant de session côté client")


class ChatResponse(BaseModel):
    session_id: str
    reply: str


class HealthResponse(BaseModel):
    ok: bool
    status: str
    startup_indexing: str


# FastAPI app 
app = FastAPI(title="Chatbot PDF Agentic", version="1.0.0")

allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "*").strip()
allowed_origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
if not allowed_origins:
    allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = pathlib.Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CHATBOT_DIR = STATIC_DIR / "chatbot"
INDEX_FILE = CHATBOT_DIR / "index.html"

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

startup_indexing_status = "Pas encore exécuté"


@app.on_event("startup")
def startup_event() -> None:
    global startup_indexing_status
    startup_indexing_status = index_pdfs_impl()
    debug_print(startup_indexing_status)


def make_session_id() -> str:
    return f"web_{uuid.uuid4().hex}"


async def run_chat(message: str, session_id: str) -> str:
    _set_active_session_id(session_id)
    session = SQLiteSession(session_id=session_id, db_path=DB_PATH)

    try:
        result = await Runner.run(CHAT_AGENT, message, session=session)
        reply = (getattr(result, "final_output", "") or "").strip()
        if reply:
            return reply
        return (
            "Bonjour, je suis prêt à vous aider avec les documents disponibles."
            if _looks_french(message)
            else "Hello, I am ready to help you with the available documents."
        )
    except Exception as exc:
        debug_print(f"Conversation error: {type(exc).__name__}: {exc}")
        return "Désolé, une erreur technique est survenue. Veuillez réessayer."


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, status=_status_pill_text(), startup_indexing=startup_indexing_status)


@app.get("/api/kb")
def kb_status() -> dict[str, Any]:
    pdf_paths = sorted(SOURCE_DIR.rglob("*.pdf"))
    latest_update = None
    if pdf_paths:
        latest_update = datetime.fromtimestamp(max(p.stat().st_mtime for p in pdf_paths)).isoformat()

    return {
        "pdf_count": len(pdf_paths),
        "latest_update": latest_update,
        "status_markdown": _kb_markdown(),
    }


@app.post("/api/reindex")
def reindex() -> dict[str, str]:
    status = index_pdfs_impl()
    return {"status": status}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest) -> ChatResponse:
    message = payload.message.strip()
    if not message:
        return ChatResponse(
            session_id=payload.session_id or make_session_id(),
            reply="Veuillez saisir une question avant d'envoyer.",
        )

    session_id = payload.session_id or make_session_id()
    reply = await run_chat(message, session_id)
    return ChatResponse(session_id=session_id, reply=reply)


@app.post("/api/chat/stream")
async def chat_stream(payload: ChatRequest):
    """SSE streaming endpoint — sends text deltas as they arrive from the LLM."""
    message = payload.message.strip()
    session_id = payload.session_id or make_session_id()

    if not message:
        async def empty_gen():
            yield f"data: {json.dumps({'session_id': session_id, 'delta': 'Veuillez saisir une question avant d\'envoyer.'})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(empty_gen(), media_type="text/event-stream")

    async def event_generator():
        # Send session_id first so the frontend can track it
        yield f"data: {json.dumps({'session_id': session_id, 'type': 'session'})}\n\n"

        _set_active_session_id(session_id)
        session = SQLiteSession(session_id=session_id, db_path=DB_PATH)

        try:
            result = Runner.run_streamed(CHAT_AGENT, message, session=session)

            async for event in result.stream_events():
                if isinstance(event, RawResponsesStreamEvent):
                    raw = event.data
                    ev_type = getattr(raw, "type", "")
                    debug_print(f"[STREAM] event type={ev_type}")
                    if ev_type == "response.output_text.delta":
                        delta_text = getattr(raw, "delta", "")
                        if delta_text:
                            yield f"data: {json.dumps({'delta': delta_text})}\n\n"

            yield "data: [DONE]\n\n"

        except Exception as exc:
            debug_print(f"Stream error: {type(exc).__name__}: {exc}")
            yield f"data: {json.dumps({'error': 'Désolé, une erreur technique est survenue. Veuillez réessayer.'})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/")
def root() -> FileResponse:
    if INDEX_FILE.exists():
        return FileResponse(str(INDEX_FILE))
    return FileResponse(str(BASE_DIR / "README.md"))

