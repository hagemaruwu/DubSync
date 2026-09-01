/**
 * translator.js
 *
 * Translates an array of English text segments to Hindi using
 * Azure Translator REST API v3.
 *
 * Batches requests (up to 100 segments per API call) to minimize round trips.
 */

import axios from 'axios';

const BATCH_SIZE = 25;
const SOURCE_LANG = 'en';
const TARGET_LANG = 'hi';

/**
 * @param {string} projectId  Unused for Azure, kept for signature compatibility
 * @param {string[]} texts    Array of English strings to translate
 * @returns {Promise<string[]>} Array of Hindi strings, same length and order as input
 */
export async function translateSegments(projectId, texts) {
  if (!texts || texts.length === 0) return [];

  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  
  if (!key || !region || !endpoint) {
    throw new Error('Azure Translator credentials not configured in .env');
  }

  const results = new Array(texts.length);

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchIndices = batch.map((_, j) => i + j);

    const data = batch.map(text => ({ text }));

    try {
      const response = await axios({
        baseURL: endpoint,
        url: '/translate',
        method: 'post',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Ocp-Apim-Subscription-Region': region,
          'Content-type': 'application/json',
        },
        params: {
          'api-version': '3.0',
          'from': SOURCE_LANG,
          'to': TARGET_LANG,
        },
        data: data,
        responseType: 'json',
      });

      response.data.forEach((item, j) => {
        // Azure returns array of objects with translations array
        results[batchIndices[j]] = item.translations[0].text;
      });
    } catch (err) {
      if (err.response && err.response.data) {
        console.error('Azure Translator API Error Response:', JSON.stringify(err.response.data, null, 2));
        throw new Error(`Azure Translator API failed: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }

    // Add a 1-second delay between batches to respect Azure Free Tier (F0) rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}
