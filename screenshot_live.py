import asyncio
from playwright.async_api import async_playwright

PUBLIC = "https://foreign-nirvana-prison-calendar.trycloudflare.com"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 900})
        page = await ctx.new_page()
        print(f"Loading {PUBLIC}...")
        await page.goto(PUBLIC + '/', wait_until='networkidle', timeout=30000)
        await page.wait_for_timeout(2000)
        await page.screenshot(path='/tmp/hivemind-LIVE.png', full_page=True)
        print(f"  Saved /tmp/hivemind-LIVE.png")
        await browser.close()

asyncio.run(main())
