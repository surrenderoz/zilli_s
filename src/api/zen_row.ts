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

export const processAddress = async (address: string) => {

    try {
        // 0. Check Redis Cache
        const cacheKey = `zillow:${address.toLowerCase().trim()}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            console.log(`Cache hit for: ${address}`);
            return JSON.parse(cached);
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
            return { address, comment: "No Zillow link found via Google Search" };
        }

        // 3. Extract ZPID
        const zpidMatch = zillowLink.link.match(/(\d+)_zpid/);
        if (!zpidMatch) {
            return { address, comment: "Failed to extract ZPID from URL" };
        }
        const zpid = zpidMatch[1];
        //         console.log(`✅ Found Zillow URL: ${zillowLink.link} (ZPID: ${zpid})`);

        // 4. Fetch Property Details (ZenRows Real Estate API)
        // This endpoint was the key difference. test.ts uses specific realestate endpoint.
        //         console.log(`🏠 Fetching property details for ZPID: ${zpid}...`);

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

                // Extra fields useful for debugging/future
                city: data.city,
                state: data.state,
                property_type: data.property_type,
                comment: ""
            };

            // Save to Redis
            await redis.set(cacheKey, JSON.stringify(result));
            return result;
        }

        return { address, comment: "Failed to fetch details (Empty response)" };

    } catch (e: any) {
        console.error(`Error processing ${address}:`, e.message);
        // If 402/429 etc, maybe we should return it as comment
        return {
            address,
            comment: `Error: ${e.message}`
        };
    }
};