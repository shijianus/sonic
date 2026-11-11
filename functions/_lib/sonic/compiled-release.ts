export interface CompiledRelease {
  baseCommit: string;
  sourceDigest: string;
  releaseId: string;
  buildTime: string;
  dirty: boolean;
  pagesArtifactDigest: string;
}

export const COMPILED_RELEASE: CompiledRelease | null = null;
