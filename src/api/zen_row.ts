import axios from "axios";
import redis from "../lib/redis";

// Use API Key from .env or fallback (matching test.ts logic)
const API_KEY = process.env.API_KEY || "e8f697bbec69cda75ca0a83dc0c3760b5d04d708";

// Helper for retries
async function retryRequest(fn: () => Promise<any>, retries = 1, delay = 1000) {
    try {
        return await fn();
    } catch (error: any) {
        if (retries > 0 && (error.response?.status >= 500 || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
            console.log(`Retrying request due to ${error.message}... (${retries} attempts left)`);
            await new Promise(res => setTimeout(res, delay));
            return retryRequest(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

interface ProcessAddressOptions {
    address: string;
    client_name?: string;
    email?: string;
    file_name?: string;
}

// Save a processed result to Redis as a permanent record (separate from cache)
// Uses a deterministic key based on file_name + address to prevent duplicates
// when the same file is re-uploaded.
async function saveResultToRedis(result: Record<string, any>) {
    try {
        const fileName = (result.file_name || 'unknown').toLowerCase().trim();
        const address = (result.address || 'unknown').toLowerCase().trim();
        // Deterministic key: same file + address = same key (overwrites, no duplicates)
        const resultKey = `result:${fileName}:${address}`;

        await redis.set(resultKey, JSON.stringify(result));

        // Also add the key to a set for easy listing
        await redis.sadd("result_keys", resultKey);
    } catch (err: any) {
        console.error("Failed to save result to Redis:", err.message);
    }
}

export const processAddress = async (opts: ProcessAddressOptions) => {
    const { address, client_name, email, file_name } = opts;

    try {
        // 0. Check Redis Cache
        const cacheKey = `zillow:${address.toLowerCase().trim()}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            console.log(`Cache hit for: ${address}`);
            const cachedResult = JSON.parse(cached);
            // Save to results store (different client/file may reference same address)
            await saveResultToRedis({
                ...cachedResult,
                client_name,
                email,
                file_name,
                savedAt: new Date().toISOString(),
            });
            return cachedResult;
        }

        console.log(`🔍 Searching Google for: ${address}...`);

        // 1. Google Search via ZenRows (Matching test.ts logic)
        const googleQuery = encodeURIComponent(`https://google.com/search?q=${address}`)
            .replaceAll('%3A%2F%2F', '://')
            .replaceAll('%2F', '/')
            .replaceAll('%3D', '=')
            .replaceAll('%3F', '?')
            .replaceAll('%20', '+').replaceAll('%2', "+") + "+zillow";

        const serpRes = await retryRequest(() => axios.get(`https://serp.api.zenrows.com/v1/targets/google/search`, {
            params: {
                apikey: API_KEY,
                country: "us",
                url: googleQuery,
            }
        }));

        // 2. Extract Valid Zillow Link
        const organicResults = serpRes.data.organic_results || [];
        const zillowLink = organicResults.find((item: any) => item.link && item.link.includes("zillow.com/homedetails"));

        if (!zillowLink) {
            const noLinkResult = { address, comment: "No Zillow link found via Google Search" };
            // Cache the negative result to avoid re-calling API for this address
            await redis.set(cacheKey, JSON.stringify(noLinkResult));
            await saveResultToRedis({ ...noLinkResult, client_name, email, file_name, savedAt: new Date().toISOString() });
            return noLinkResult;
        }

        // 3. Extract ZPID
        const zpidMatch = zillowLink.link.match(/(\d+)_zpid/);
        if (!zpidMatch) {
            const noZpidResult = { address, comment: "Failed to extract ZPID from URL", property_url: zillowLink.link };
            // Cache the negative result to avoid re-calling API for this address
            await redis.set(cacheKey, JSON.stringify(noZpidResult));
            await saveResultToRedis({ ...noZpidResult, client_name, email, file_name, savedAt: new Date().toISOString() });
            return noZpidResult;
        }
        const zpid = zpidMatch[1];

        // 4. Fetch Property Details (ZenRows Real Estate API)
        const propertyResponse = await retryRequest(() => axios.get(`https://realestate.api.zenrows.com/v1/targets/zillow/properties/${zpid}`, {
            params: {
                apikey: API_KEY,
            }
        }));

        const data = propertyResponse.data;

        if (data) {
            // Map to our schema
            const result = {
                address, // Original search address

                // Mapped fields based on test.ts output structure
                zillow_address: data.address,
                zillow_estimated_price: data.zillow_estimated_price || data.property_price,
                zipcode: data.zipcode,
                property_url: data.property_url || zillowLink.link,

                // Extra fields
                city: data.city,
                state: data.state,
                property_type: data.property_type,
                zpid: zpid,
                comment: ""
            };

            // Save to Redis cache (for deduplication)
            await redis.set(cacheKey, JSON.stringify(result));

            // Save to Redis results store (permanent record)
            await saveResultToRedis({
                ...result,
                client_name,
                email,
                file_name,
                savedAt: new Date().toISOString(),
                rawData: data,
            });

            return result;
        }

        const emptyResult = { address, comment: "Failed to fetch details (Empty response)", zpid, property_url: zillowLink.link };
        await saveResultToRedis({ ...emptyResult, client_name, email, file_name, savedAt: new Date().toISOString() });
        return emptyResult;

    } catch (e: any) {
        console.error(`Error processing ${address}:`, e.message);
        const errorResult = { address, comment: `Error: ${e.message}` };
        await saveResultToRedis({ ...errorResult, client_name, email, file_name, savedAt: new Date().toISOString() });
        return errorResult;
    }
};