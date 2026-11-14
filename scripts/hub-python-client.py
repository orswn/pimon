# /// script
# requires-python = ">=3.13"
# dependencies = ["a2a-sdk==1.3.0"]
# ///
"""Check the hub with the official Python A2A client: card, SendMessage, SendStreamingMessage, GetTask.

Usage: uv run scripts/hub-python-client.py [hub-url]   (default http://127.0.0.1:18080, needs --test-agents)
"""

import asyncio
import sys
import uuid

import httpx
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.types import GetTaskRequest, Message, Part, Role, SendMessageRequest, TaskState

HUB = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:18080"
AGENT_URL = f"{HUB}/a2a/echo"
failures = 0


def check(name: str, ok: bool, detail: object = "") -> None:
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}")


def text_of(parts) -> str:
    return "".join(part.text for part in parts)


async def run(streaming: bool) -> None:
    mode = "SendStreamingMessage" if streaming else "SendMessage"
    async with httpx.AsyncClient() as http:
        card = await A2ACardResolver(http, AGENT_URL).get_agent_card()
    check(f"{mode}: card resolves", card.name == "echo" and card.capabilities.streaming, card.name)
    client = ClientFactory(ClientConfig(streaming=streaming)).create(card)
    try:
        body = f"hello {mode}"
        request = SendMessageRequest(
            message=Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(text=body)])
        )
        events = [event async for event in client.send_message(request)]
        kinds = [event.WhichOneof("payload") for event in events]
        task = next((event.task for event in events if event.WhichOneof("payload") == "task"), None)
        check(f"{mode}: first event is a task", kinds[:1] == ["task"], kinds)
        task_id = task.id if task else ""
        if streaming:
            states = [e.status_update.status.state for e in events if e.WhichOneof("payload") == "status_update"]
            artifacts = [text_of(e.artifact_update.artifact.parts) for e in events if e.WhichOneof("payload") == "artifact_update"]
            check(f"{mode}: artifact then COMPLETED", artifacts == [body] and states[-1:] == [TaskState.TASK_STATE_COMPLETED], kinds)
        else:
            check(
                f"{mode}: COMPLETED with echo artifact",
                task is not None and task.status.state == TaskState.TASK_STATE_COMPLETED and text_of(task.artifacts[0].parts) == body,
                TaskState.Name(task.status.state) if task else None,
            )
        got = await client.get_task(GetTaskRequest(id=task_id))
        check(
            f"{mode}: GetTask",
            got.status.state == TaskState.TASK_STATE_COMPLETED and text_of(got.artifacts[0].parts) == body,
            TaskState.Name(got.status.state),
        )
    finally:
        await client.close()


async def main() -> int:
    await run(streaming=False)
    await run(streaming=True)
    print(f"{failures} failure(s)")
    return 1 if failures else 0


raise SystemExit(asyncio.run(main()))
