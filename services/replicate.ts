// Stub service for Replicate routing (google/nano-banana).
// Replace with real SDK calls. Keep the function shapes stable.

export type ReplicateInput = {
    prompt: string;
    negativePrompt?: string;
    guidance?: number;
    strength?: number;
    seed?: number | null;
    batch?: number;
};

export type ReplicateResult = {
    urls: string[];
    seed: number;
};

export async function runReplicate(_input: ReplicateInput): Promise<ReplicateResult> {
    // This is a no-op stub; actual generation is simulated in the route for now.
    return { urls: [], seed: Math.floor(Math.random() * 1e6) };
}

