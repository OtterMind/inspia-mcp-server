// Public API vocabulary from Inspia fec2f43: prompt-taxonomy.ts and prompt-catalog-policy.ts.
// These are source-catalog filters, never generation capabilities. Counts are checked live.
export const SOURCE_MODELS = [
  { value: "gpt-image-2", label: "GPT Image", mediaType: "image" },
  { value: "nano-banana", label: "Nano Banana", mediaType: "image" },
  { value: "seedance", label: "Seedance", mediaType: "video" },
  { value: "midjourney", label: "Midjourney", mediaType: "image" },
] as const;

export const SUBJECTS = [
  { value: "people", label: "People" },
  { value: "characters", label: "Characters" },
  { value: "products-food", label: "Products & Food" },
  { value: "graphics-abstract", label: "Graphics & Abstract" },
  { value: "places-scenery", label: "Places & Scenery" },
  { value: "animals-creatures", label: "Animals & Creatures" },
] as const;
