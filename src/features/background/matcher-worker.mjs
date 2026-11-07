// Runs one monitor's regex off the main thread. The host terminates this worker when a reply
// misses the deadline. Nothing here may be async: a stalled test must stall only this thread.
import { parentPort, workerData } from "node:worker_threads";

let expression;
try {
	expression = new RegExp(workerData.source, workerData.flags);
	parentPort.postMessage({ type: "ready" });
} catch (error) {
	parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

parentPort.on("message", (message) => {
	if (!message || message.type !== "line" || !expression) return;
	let matched = false;
	try {
		matched = expression.test(message.text);
	} catch {
		matched = false;
	}
	parentPort.postMessage({ type: "done", seq: message.seq, matched });
});
