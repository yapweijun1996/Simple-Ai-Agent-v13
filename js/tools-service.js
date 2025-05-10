/**
 * ./js/tools-service.js
 * Tools Service Module - Provides webSearch and readUrl functions for the AI agent.
 */
const ToolsService = (function() {
    'use strict';

    // Proxy list for bypassing CORS
    const proxies = [
      { name: 'CodeTabs',          formatUrl: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,                      parseResponse: async res => res.text() },
      { name: 'AllOrigins (win)',  formatUrl: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,                parseResponse: async res => res.text() },
      { name: 'AllOrigins (cf)',   formatUrl: url => `https://api.allorigins.cf/raw?url=${encodeURIComponent(url)}`,                parseResponse: async res => res.text() },
      { name: 'AllOrigins (pro)',  formatUrl: url => `https://api.allorigins.pro/raw?url=${encodeURIComponent(url)}`,               parseResponse: async res => res.text() },
      { name: 'AllOrigins (app)',  formatUrl: url => `https://allorigins.appspot.com/raw?url=${encodeURIComponent(url)}`,            parseResponse: async res => res.text() },
      { name: 'CORS Anywhere',     formatUrl: url => `https://cors-anywhere.herokuapp.com/${url}`,                                parseResponse: async res => res.text() },
      { name: 'ThingProxy FB',     formatUrl: url => `https://thingproxy.freeboard.io/fetch/${url}`,                       parseResponse: async res => res.text() },
      { name: 'ThingProxy PW',     formatUrl: url => `https://thingproxy.pw/fetch/${url}`,                                 parseResponse: async res => res.text() },
      { name: 'CORSProxy.io',      formatUrl: url => `https://corsproxy.io/?${url}`,                                     parseResponse: async res => res.text() },
      { name: 'CORS.bridged.cc',   formatUrl: url => `https://cors.bridged.cc/${url}`,                                    parseResponse: async res => res.text() },
      { name: 'YACDN',             formatUrl: url => `https://yacdn.org/proxy/${url}`,                                    parseResponse: async res => res.text() },
      { name: 'JSONP afeld',       formatUrl: url => `https://jsonp.afeld.me/?url=${encodeURIComponent(url)}`,          parseResponse: async res => (await res.json()).contents },
      { name: 'CORS Proxy HTML',   formatUrl: url => `https://cors-proxy.htmldriven.com/?url=${encodeURIComponent(url)}`, parseResponse: async res => res.text() },
      { name: 'AllOrigins .net',   formatUrl: url => `https://api.allorigins.net/raw?url=${encodeURIComponent(url)}`,               parseResponse: async res => res.text() },
      { name: 'AllOrigins .io',    formatUrl: url => `https://api.allorigins.io/raw?url=${encodeURIComponent(url)}`,                parseResponse: async res => res.text() },
      { name: 'AllOrigins .eu',    formatUrl: url => `https://api.allorigins.eu/raw?url=${encodeURIComponent(url)}`,                parseResponse: async res => res.text() },
      { name: 'ProxyCORS',         formatUrl: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,           parseResponse: async res => res.text() },
      { name: 'RainDrop CORS',     formatUrl: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,                parseResponse: async res => res.text() },
      { name: 'DirectNoCORS',      formatUrl: url => url,                                                                parseResponse: async res => {
                                                                                                          const text = await res.text().catch(()=> '');
                                                                                                          return text;
                                                                                                        }, options: { mode: 'no-cors' } },
      { name: 'FinalFallback',     formatUrl: url => url,                                                                parseResponse: async res => res.text() }
    ];

    // Proxy health tracking
    const proxyHealth = new Map(proxies.map(p => [p.name, 1]));

    function getFinalUrl(rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.pathname === '/l/' && parsed.searchParams.has('uddg')) {
          return decodeURIComponent(parsed.searchParams.get('uddg'));
        }
      } catch {}
      return rawUrl;
    }

    /**
     * Performs a search via the specified engine (duckduckgo, google, bing), streams results as found.
     * @param {string} query
     * @param {function} onResult - Callback for each result as it's found
     * @param {string} [engine] - Search engine: 'duckduckgo', 'google', or 'bing'
     * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
     */
    async function webSearch(query, onResult, engine = 'duckduckgo') {
      let searchUrl, parseResults;
      if (engine === 'google') {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const items = doc.querySelectorAll('div.g');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a');
            const titleElem = item.querySelector('h3');
            if (!anchor || !titleElem) return;
            const href = anchor.href;
            const title = titleElem.textContent.trim();
            const snippetElem = item.querySelector('.VwiC3b, .IsZvec');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      } else if (engine === 'bing') {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const items = doc.querySelectorAll('li.b_algo');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a');
            const titleElem = item.querySelector('h2');
            if (!anchor || !titleElem) return;
            const href = anchor.href;
            const title = titleElem.textContent.trim();
            const snippetElem = item.querySelector('p');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      } else {
        // Default to DuckDuckGo
        searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        parseResults = function(htmlString) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          const container = doc.getElementById('links');
          if (!container) return [];
          const items = container.querySelectorAll('div.result');
          const results = [];
          items.forEach(item => {
            const anchor = item.querySelector('a.result__a');
            if (!anchor) return;
            const href = getFinalUrl(anchor.href);
            const title = anchor.textContent.trim();
            const snippetElem = item.querySelector('a.result__snippet, div.result__snippet');
            const snippet = snippetElem ? snippetElem.textContent.trim() : '';
            results.push({ title, url: href, snippet });
          });
          return results;
        };
      }
      // Sort proxies by health score
      const sortedProxies = proxies.slice().sort((a, b) => (proxyHealth.get(b.name) || 0) - (proxyHealth.get(a.name) || 0));
      let partialResults = [];
      for (const proxy of sortedProxies) {
        try {
          const response = await fetch(proxy.formatUrl(searchUrl));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const htmlString = await proxy.parseResponse(response);
          const results = parseResults(htmlString);
          if (!results.length) throw new Error('No results');
          results.forEach(result => { if (onResult) onResult(result); });
          proxyHealth.set(proxy.name, (proxyHealth.get(proxy.name) || 1) + 2); // reward
          return results;
        } catch (err) {
          proxyHealth.set(proxy.name, (proxyHealth.get(proxy.name) || 1) - 2); // penalize
          if (partialResults.length) {
            if (onResult) partialResults.forEach(r => onResult(r));
            return partialResults;
          }
        }
      }
      throw new Error('All proxies failed');
    }

    /**
     * Fetches and returns text content from a URL via proxies.
     * @param {string} url
     * @returns {Promise<string>}
     */
    async function readUrl(url) {
      for (const proxy of proxies) {
        try {
          const response = await fetch(proxy.formatUrl(url));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const htmlString = await proxy.parseResponse(response);
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlString, 'text/html');
          // Remove <script> and <style> elements
          doc.querySelectorAll('script, style').forEach(el => el.remove());
          // Extract text only from p, h1, h2, and h3 tags
          const selectors = ['p', 'h1', 'h2', 'h3'];
          const texts = [];
          selectors.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => {
              const t = el.textContent.trim();
              if (t) texts.push(t);
            });
          });
          const resultText = texts.join('\n\n').trim();
          return resultText;
        } catch (err) {
          console.warn(`Proxy ${proxy.name} failed: ${err.message}`);
        }
      }
      throw new Error('All proxies failed');
    }

    /**
     * Fetches Instant Answer from DuckDuckGo API.
     * @param {string} query - The search query.
     * @returns {Promise<Object>} - The JSON response from DuckDuckGo Instant Answer API.
     */
    async function instantAnswer(query) {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&pretty=1`;
      let response;
      // Try via CORS proxy first to avoid CORS issues
      try {
        response = await Utils.fetchWithProxyRetry(url, { method: 'GET' });
      } catch (proxyErr) {
        console.warn('Instant Answer proxy fetch failed, falling back to direct fetch:', proxyErr);
        // Fallback to direct fetch
        response = await fetch(url);
      }
      if (!response.ok) {
        const errText = await (response.text().catch(() => ''));    
        throw new Error(`Instant Answer API error ${response.status}: ${errText}`);
      }
      return response.json();
    }

    return { webSearch, readUrl, instantAnswer };
})(); 