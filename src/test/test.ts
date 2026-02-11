const axios = require('axios');
// const cheerio = require('cheerio'); // Not needed as API returns JSON

const API_KEY = process.env.API_KEY;

console.log(API_KEY)

async function getZillowData(incompleteAddress: any) {

    // --- STEP 1: Google the Incomplete Address ---
    console.log(`🔍 Searching Google for: ${incompleteAddress}...`);

    // We restrict results to zillow.com to ensure we get a Zillow link
    // const googleQuery = encodeURIComponent(`site: zillow.com ${incompleteAddress}`);
    const googleQuery = encodeURIComponent(`https://google.com/search?q=${incompleteAddress}`)
        .replaceAll('%3A%2F%2F', '://')
        .replaceAll('%2F', '/')
        .replaceAll('%3D', '=')
        .replaceAll('%3F', '?')
        .replaceAll('%20', '+').replaceAll('%2', "+") + "+zillow";
    console.log(googleQuery)
    try {
        // Use ZenRows to scrape the Google Search Result Page
        const searchResponse = await axios.get(`https://serp.api.zenrows.com/v1/targets/google/search`, {
            params: {
                apikey: API_KEY,
                country: "us",
                url: googleQuery,
            },
        });

        // console.log(searchResponse.data)
        // Parse Google results (JSON format from ZenRows SERP API)
        const organicResults = searchResponse.data.organic_results || [];
        const zillowResult = organicResults.find((item: any) => item.link && item.link.includes("zillow.com/homedetails"));

        if (!zillowResult) {
            console.log('❌ No valid Zillow link found on Google.');
            return;
        }

        const cleanUrl = zillowResult.link;
        console.log(`✅ Found Zillow URL: ${cleanUrl}`);

        // Extract ZPID
        const zpidMatch = cleanUrl.match(/\/(\d+)_zpid/);
        if (!zpidMatch) {
            console.log('❌ Could not extract ZPID from URL.');
            return;
        }
        const zpid = zpidMatch[1];
        console.log(`🔢 Extracted ZPID: ${zpid}`);

        // --- STEP 2: Fetch Property Data from ZenRows ---
        console.log('🏠 Fetching property details...');

        const propertyResponse = await axios.get(`https://realestate.api.zenrows.com/v1/targets/zillow/properties/${zpid}`, {
            params: {
                apikey: API_KEY,
            },
        });

        console.log('🎉 Data Received:');
        console.log(propertyResponse.data);

    } catch (error) {
        console.error('Error:', error?.message);
    }
}

// Run it with your incomplete address
getZillowData('Arcadia Hostel Ekiti State University Charlotte NC US');