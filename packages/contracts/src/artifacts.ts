// artifacts.ts — content-addressed immutable artifacts (spec §20).

export interface ArtifactManifest {
  id: string;
  sha256: string;
  mediaType: string;
  size: number;
  logicalName: string;
  producer: string;
  campaignId: string;
  branchId?: string;
  experimentId?: string;
  parents: string[];
  createdAt: string;
  /** relative path inside the campaign artifact store */
  storagePath: string;
}
