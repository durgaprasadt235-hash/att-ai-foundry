"""Live Groq client for the AT&T AI Foundry agent (server/groq_client.py).

Calls Groq's OpenAI-compatible API at https://api.groq.com/openai/v1 with
model openai/gpt-oss-120b. No new dependencies: plain urllib, like the rest
of the reference backend.

Two facts that cost a morning to learn, so they are written down here:
* Groq (behind Cloudflare) returns 403 error code 1010 for the default
  Python-urllib User-Agent. Every request MUST send a real User-Agent
  ("att-ai-foundry/1.0") or it is blocked before the key is even checked.
  The stored key was fine all along; the User-Agent was the bug.
* Model llama-3.1-8b-instant is NOT available on this account (Groq returns
  404 model_not_found). Use openai/gpt-oss-120b only.

The client never fakes an answer. On a missing key, a 429, a 404, a 5xx,
a timeout, or an invalid leaf pick it raises GroqUnavailable, and the
engine falls back to the deterministic path and says so in the trace.
The key comes from the GROQ_API_KEY environment variable only — never
from code, never from git. On Vercel it is a project environment variable.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

BASE_URL = "https://api.groq.com/openai/v1"
MODEL = "openai/gpt-oss-120b"
USER_AGENT = "att-ai-foundry/1.0"
TIMEOUT_SECONDS = 20


class GroqUnavailable(Exception):
    """Groq could not be used for this call (missing key, rate limit,
    model not found, server error, timeout, or an invalid leaf pick).
    Callers treat this as 'fall back to the deterministic engine', never
    as a reason to invent an answer."""

    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise GroqUnavailable("Groq redirected the request; refusing to follow it")


class GroqClient:
    """Minimal Groq chat client. Only two operations the agent needs:
    pick a STAIR leaf from an allowlist, and draft a customer summary."""

    def __init__(self, api_key: str, model: str = MODEL):
        if not api_key:
            raise GroqUnavailable("GROQ_API_KEY is not set")
        self.api_key = api_key
        self.model = model

    @classmethod
    def from_env(cls) -> "GroqClient":
        """Build a client from GROQ_API_KEY, or raise GroqUnavailable."""
        return cls(os.environ.get("GROQ_API_KEY", ""))

    def chat(self, messages: list[dict], json_mode: bool = False,
             max_tokens: int = 300) -> str:
        """One chat completion. Returns the assistant's text content."""
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        request = urllib.request.Request(
            f"{BASE_URL}/chat/completions",
            data=json.dumps(payload).encode(),
            method="POST",
        )
        request.add_header("Content-Type", "application/json")
        # Real User-Agent is REQUIRED: Cloudflare blocks Python-urllib (403/1010).
        request.add_header("User-Agent", USER_AGENT)
        request.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.build_opener(_NoRedirect()).open(
                    request, timeout=TIMEOUT_SECONDS) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            raise GroqUnavailable(
                f"Groq returned HTTP {e.code}: {detail}", status=e.code) from e
        except (urllib.error.URLError, TimeoutError) as e:
            raise GroqUnavailable(f"Groq request failed: {e}") from e
        try:
            return body["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as e:
            raise GroqUnavailable("Groq returned an unexpected response shape") from e

    def pick_leaf(self, query: str, leaves: list[dict]) -> str:
        """Ask Groq to pick one STAIR leaf for a query, from the TOC
        allowlist only. Returns the picked leaf id. The pick is validated
        here against the allowlist; an invented or unknown id raises
        GroqUnavailable, and the engine falls back to deterministic STAIR."""
        allowed_ids = {leaf["id"] for leaf in leaves}
        toc = "\n".join(
            f"- {leaf['id']}: {leaf['path']} {leaf['section']}" for leaf in leaves)
        content = self.chat([
            {"role": "system", "content":
             "You pick one policy section for a customer-service case. "
             "Reply with JSON only: {\"leaf_id\": \"<one id from the list>\"}. "
             "Pick only an id from the list. If none fits, reply "
             "{\"leaf_id\": null}."},
            {"role": "user", "content":
             f"Case query: {query}\n\nPolicy sections:\n{toc}"},
        ], json_mode=True, max_tokens=120)
        try:
            picked = json.loads(content).get("leaf_id")
        except json.JSONDecodeError as e:
            raise GroqUnavailable(f"Groq leaf pick was not valid JSON: {content[:200]}") from e
        if picked is None:
            raise GroqUnavailable("Groq picked no leaf for this query")
        if picked not in allowed_ids:
            raise GroqUnavailable(
                f"Groq picked leaf id {picked!r}, which is not in the TOC allowlist")
        return picked

    def draft_summary(self, case: dict, citation: str, proposed_action: str) -> str:
        """Draft a short customer-facing summary of a proposed action.
        The summary is words only — it never changes amounts, plans, or
        decisions, and it is shown alongside the engine's own trace."""
        content = self.chat([
            {"role": "system", "content":
             "Write one short customer-facing paragraph (at most 3 sentences) "
             "explaining a proposed resolution. Use only the facts given. "
             "Do not invent amounts, dates, or policy terms. Plain language."},
            {"role": "user", "content":
             f"Case {case.get('id')} ({case.get('type')}): {case.get('description', '')}\n"
             f"Grounded in: {citation}\nProposed action: {proposed_action}"},
        ], max_tokens=200)
        return content.strip()
