import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) =>
	(await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Loopback, RFC 1918, link-local, ULA, CGNAT, unspecified, and multicast. */
const DENIED: readonly (readonly [string, number])[] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
];

/** The TCK and test webhooks listen on loopback. */
export const TEST_AGENT_ALLOW: readonly string[] = ["127.0.0.0/8", "::1"];

const HOST_NAME =
	/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

function family(ip: string): "ipv4" | "ipv6" {
	return isIP(ip) === 6 ? "ipv6" : "ipv4";
}

/** A comma list of host names, IP addresses, and CIDRs. Throws on a bad entry. */
export function parsePushAllow(value: string | undefined): string[] {
	const entries = (value ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== "");
	for (const entry of entries) {
		const slash = entry.indexOf("/");
		if (slash >= 0) {
			const ip = entry.slice(0, slash);
			const bits = entry.slice(slash + 1);
			const max = isIP(ip) === 6 ? 128 : 32;
			if (isIP(ip) === 0 || !/^\d{1,3}$/.test(bits) || Number(bits) > max) {
				throw new Error(`push allow entry ${entry} is not a valid CIDR`);
			}
		} else if (isIP(entry) === 0 && !HOST_NAME.test(entry.replace(/\.$/, ""))) {
			throw new Error(`push allow entry ${entry} is not a host name, address, or CIDR`);
		}
	}
	return entries;
}

function urlHost(url: URL): string {
	return url.hostname
		.replace(/^\[(.*)\]$/, "$1")
		.replace(/\.$/, "")
		.toLowerCase();
}

/** Decides which push webhook addresses the hub may reach. */
export class PushGuard {
	readonly #denied = new BlockList();
	readonly #allowed = new BlockList();
	readonly #hosts = new Set<string>();
	readonly #resolve: Resolver;

	constructor(allow: readonly string[] = [], resolver: Resolver = defaultResolver) {
		this.#resolve = resolver;
		for (const [network, prefix] of DENIED) this.#denied.addSubnet(network, prefix, family(network));
		for (const entry of parsePushAllow(allow.join(","))) {
			const slash = entry.indexOf("/");
			if (slash >= 0) {
				const network = entry.slice(0, slash);
				this.#allowed.addSubnet(network, Number(entry.slice(slash + 1)), family(network));
			} else if (isIP(entry) !== 0) {
				this.#allowed.addAddress(entry, family(entry));
			} else {
				this.#hosts.add(entry.replace(/\.$/, ""));
			}
		}
	}

	addressAllowed(ip: string): boolean {
		const kind = family(ip);
		return this.#allowed.check(ip, kind) || !this.#denied.check(ip, kind);
	}

	/** Config time: refuses an IP literal in a denied range. A host name is checked at send time. */
	checkUrl(url: URL): string | undefined {
		const host = urlHost(url);
		if (isIP(host) === 0 || this.addressAllowed(host)) return undefined;
		return `push url address ${host} is not allowed`;
	}

	/** Send time: every resolved address must be allowed. Returns the reason for a refusal. */
	async checkSend(rawUrl: string): Promise<string | undefined> {
		const host = urlHost(new URL(rawUrl));
		if (this.#hosts.has(host)) return undefined;
		if (isIP(host) !== 0) return this.addressAllowed(host) ? undefined : `push url address ${host} is not allowed`;
		let addresses: string[];
		try {
			addresses = await this.#resolve(host);
		} catch (error) {
			return `cannot resolve ${host}: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (addresses.length === 0) return `cannot resolve ${host}`;
		const denied = addresses.find((address) => !this.addressAllowed(address));
		return denied ? `push host ${host} resolves to ${denied}, which is not allowed` : undefined;
	}
}
