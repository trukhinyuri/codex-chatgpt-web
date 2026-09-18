// Types for scripts/cliproxyapi-build.cjs, which the launcher's Node packaging script also loads.
type FetchLike = (url: string, init?: { redirect?: "follow" }) => Promise<Response>;

interface GoArchive { file: string; sha256: string }
interface Manifest {
  go: { version: string; archives: Record<string, GoArchive> };
  antigravityClient: { repository: string; commit: string; path: string; sha256: string };
}
interface AntigravityClient { clientId: string; clientSecret: string }
interface Toolchain { go: string; version: string; source: "override" | "pinned"; cache: string }

declare const build: {
  ANTIGRAVITY_PACKAGE: string;
  MANIFEST: Manifest;
  antigravityClient(options?: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike; cache?: string }): Promise<AntigravityClient>;
  antigravityLdflags(client: AntigravityClient): string;
  cacheRoot(env?: Record<string, string | undefined>, platform?: string, home?: string): string;
  embeddedClientLiterals(root: string): string[];
  ensureGo(options?: {
    env?: Record<string, string | undefined>;
    platform?: string;
    arch?: string;
    fetchImpl?: FetchLike;
    log?: (line: string) => void;
    cache?: string;
  }): Promise<Toolchain>;
  goEnv(cache: string, env?: Record<string, string | undefined>): Record<string, string | undefined>;
  parseAntigravityClient(source: string): AntigravityClient;
  transientError(message: string, cause?: unknown): Error & { transient: true };
};

export = build;
