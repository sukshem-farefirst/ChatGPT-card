export async function shortenDeeplinks(urls) {
  if (!urls || urls.length === 0) return urls;
  
  try {
    const response = await fetch(
      "https://shortnerurl-5oz2r3w4ya-uc.a.run.app/shorten",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      }
    );
    
    if (!response.ok) return urls;
    const data = await response.json();
    if (!data?.shortUrls || !Array.isArray(data.shortUrls)) return urls;
    return data.shortUrls;
  } catch (error) {
    console.error("URL shortening error:", error);
    return urls;
  }
}