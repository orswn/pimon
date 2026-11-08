// A human message in the current run segment authorizes goal_set. `input` fires when the message is
// typed, but it reaches the model only when it lands, so one flag per input waits in a queue.
// TODO(okka): the queue has two known gaps. A follow-up typed after the run closed the queue at
// agent_before_settle, but before pi queued it, lands with no flag, so it opens no window and ends no
// wait. A prompt sent while streaming without a streaming behavior emits an idle input and then fails,
// which drops the flags of messages that are still queued.

export interface Authority {
	/** One flag per input that has not landed yet. True for a human source. */
	queue: boolean[];
	/** Text of the last human message that landed in this run segment. */
	window: string | undefined;
}

export const openAuthority = (): Authority => ({ queue: [], window: undefined });

/** An idle input starts a new run, so no earlier input can still be waiting. */
export function onInput(authority: Authority, source: string, streaming: string | undefined): Authority {
	const earlier = streaming === undefined ? [] : authority.queue;
	return { queue: [...earlier, source !== "extension"], window: authority.window };
}

export function onUserMessage(authority: Authority, text: string): Authority {
	const [human, ...rest] = authority.queue;
	return { queue: rest, window: human ? text.trim() || "(no text)" : authority.window };
}

export const closeAuthority = (): Authority => openAuthority();
