// Stub service for SDXL Base + InstantID/IP-Adapter route.
// Real implementation should take a reference image and face crop and return URLs.

export type SDXLInput = {
    refFullPath: string;
    refFacePath: string;
    prompt: string;
    negativePrompt?: string;
    guidance?: number;
    strength?: number;
    seed?: number | null;
    batch?: number;
};

export type SDXLResult = {
    urls: string[];
    seed: number;
};

export async function runSDXL(_input: SDXLInput): Promise<SDXLResult> {
    return { urls: [], seed: Math.floor(Math.random() * 1e6) };
}

