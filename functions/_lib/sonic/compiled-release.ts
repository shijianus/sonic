export interface CompiledRelease {
  baseCommit: string;
  sourceDigest: string;
  releaseId: string;
  buildTime: string;
  dirty: boolean;
  pagesArtifactDigest?: string;
  engineIdentityCompiled?: true;
}

declare const SONIC_COMPILED_ENGINE_RELEASE: CompiledRelease | null | undefined;

export const COMPILED_RELEASE: CompiledRelease | null = typeof SONIC_COMPILED_ENGINE_RELEASE === 'undefined'
  ? null : SONIC_COMPILED_ENGINE_RELEASE;
