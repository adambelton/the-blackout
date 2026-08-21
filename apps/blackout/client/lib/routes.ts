/**
 * Typed route builders for the Blackout server's HTTP API.
 *
 * Pages should construct paths through this object rather than
 * inlining template strings — a renamed endpoint becomes a
 * compile-time error here instead of a runtime 404 in some unrelated
 * client. Grep for a single rename target; never wonder which inline
 * string concat needs updating.
 *
 * Add new entries as their pages migrate. Naming convention: nest by
 * resource, leaf functions take ids in declaration order. Static
 * suffixes are nested fields, not args.
 */
export const routes = {
  radioSources: {
    list: () => "/radio-sources",
    item: (id: string) => `/radio-sources/${id}`,
  },
  fixtures: {
    upcoming: () => "/fixtures/upcoming",
  },
  broadcasts: {
    list: () => "/broadcasts",
    item: (id: string) => `/broadcasts/${id}`,
    moderatorView: (id: string) => `/broadcasts/${id}/moderator-view`,
    health: (id: string) => `/broadcasts/${id}/health`,
    cycles: (id: string, opts?: { limit?: number }) =>
      `/broadcasts/${id}/cycles${opts?.limit ? `?limit=${opts.limit}` : ""}`,
    cycle: (id: string, cycleId: string) => `/broadcasts/${id}/cycles/${cycleId}`,
    generation: (id: string, generationId: string) =>
      `/broadcasts/${id}/generations/${generationId}`,
    narrationMedia: (id: string, narrativeId: string) =>
      `/broadcasts/${id}/narratives/${narrativeId}/media`,
    entries: (id: string, opts?: { source?: string }) =>
      `/broadcasts/${id}/entries${opts?.source ? `?source=${encodeURIComponent(opts.source)}` : ""}`,
    studio: {
      pool: (id: string) => `/broadcasts/${id}/studio/pool`,
      poolItem: (id: string, poolItemId: string) =>
        `/broadcasts/${id}/studio/pool/${poolItemId}`,
      suggestPrompts: (id: string) => `/broadcasts/${id}/studio/prompts/suggest`,
      discardPrompt: (id: string) => `/broadcasts/${id}/studio/prompts/discard`,
      generateIllustration: (id: string) =>
        `/broadcasts/${id}/studio/illustrations/generate`,
      acceptIllustration: (id: string, illustrationId: string) =>
        `/broadcasts/${id}/studio/illustrations/${illustrationId}/accept`,
      discardIllustration: (id: string, illustrationId: string) =>
        `/broadcasts/${id}/studio/illustrations/${illustrationId}/discard`,
    },
  },
  tts: {
    voices: () => "/tts/voices",
    speak: () => "/tts",
  },
  ttsVoices: {
    list: () => "/tts-voices",
  },
  admin: {
    users: {
      list: () => "/admin/users",
      setRole: (id: string) => `/admin/users/${id}/role`,
    },
    ttsVoices: {
      list: () => "/admin/tts-voices",
      item: (id: string) => `/admin/tts-voices/${id}`,
      preview: () => "/admin/tts/preview",
    },
  },
};
