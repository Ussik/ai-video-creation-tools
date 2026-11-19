export type MediaInputManifest = { body_hash: string; request_bytes: number; encoded_image_bytes: number; duplicate_image_occurrences: number;
  entries: Array<{ field_path: string; content_index?: number; asset_ids: string[]; digest: string; encoded_bytes: number }> }
export type MediaInputRejection = { status: 'provider_rejected'; upstream_code?: string; provider_request_id?: string; content_indices: number[];
  inputs: MediaInputManifest['entries']; mapping_status: 'matched' | 'partial' | 'unmapped' }
export type JobProviderInputs = { manifest: MediaInputManifest | null; rejection: MediaInputRejection | null;
  source_nodes?: Array<{ id: string; title: string; asset_id: string; canvas_id: string | null; shot_id: string | null }> }
