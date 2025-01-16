import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";


puppeteer.use(StealthPlugin());


function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function random(max: number, min: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
// const random_screen_size =
const RunScrapper = async (address: string) => {

  let br: any = undefined;
  try {
    const random_IP = Math.floor(Math.random() * 100) + 1;
    const random_Agent = Math.floor(Math.random() * 29) + 1;

    const proxyURL = require("../../Free_Proxy_List.json");
    const user_agents = require("../../user_agent.json");

    //

    const pathToExtension = "./ext";

    const proxy = `${proxyURL[random_IP]["protocols"][0]}://${proxyURL[random_IP]["ip"]}:${proxyURL[random_IP]["port"]}`;
    // console.log(proxy, "proxy lenght")

    const browser = await puppeteer.launch({
      headless: false,
    //   browser: "firefox",
      defaultViewport: { width: random(1600, 800), height: random(1100, 800) },
      args: [
        `--load-extension=${pathToExtension}`
      ]
    //   args: ["--no-sandbox"],
      //   args: [`--proxy-server=${proxy}`]
    });
    br = browser;
    const page = await browser.newPage();

    console.log(user_agents.user_agents[random_Agent], "jimm");
    
    await page.setUserAgent(user_agents.user_agents[random_Agent]);
    // await page.();

    ////
    ////////
    let searchTerm = `${address}`; // Replace this with your variable's value
    searchTerm = searchTerm.trim();
    await page.goto(
        `https://duckduckgo.com/?q=site:zillow.com+inurl:homedetails+${searchTerm}&kl=us-en`,
        {
      waitUntil: "domcontentloaded",
    });

    // try {
    //   await page.click('button[aria-label="Accept all"]', { delay: 3000 });
    // } catch (e) {
    //   console.log("No cookie consent popup found");
    // }
    // await page.type(".searchbox_input__bEGm3", searchTerm);

    // await page.keyboard.press("Enter");

    await page.waitForSelector(".At_VJ9MlrHsSjbfCtz2_", { visible: true });
    await page.waitForSelector(".eVNpHGjtxRBq_gLOfGDr", { visible: true });

    await page.click(".eVNpHGjtxRBq_gLOfGDr", { delay: 500 });

    await delay(Math.floor(Math.random() * 10000) + 1);

    await page.mouse.move(100, 200);
    await page.mouse.move(150, 250, { steps: 10 });
    // await page.keyboard.type("Hello ", { delay: 100 });

    // await page.waitForSelector(
    //   ".ZestimateOfferTemplate__StyledWrapper-sc-9dsw9o-0",
    //   { visible: true }
    // );

    // await page.waitForSelector('.zestimate-above-toggle', {visible: true});

    // await page.waitForSelector('.fbnoHg', {visible: true, timeout: 3000})
    // setTimeout(() => {}, 3000);
    await delay(Math.floor(Math.random() * 5000) + 1);

    await page.mouse.move(150, 250, { steps: 10 });
    const zesti = await page.evaluate(() => {
      const link = document.querySelector(".dFhjAe");
      const also = document.querySelector(".Text-c11n-8-99-3__sc-aiai24-0 StyledHeading-c11n-8-99-3__sc-s7fcif-0 fbnoHg")
      const el = document.querySelector('span[data-testid="price"]');
      // await browser.close()

      return link?.childNodes[0].textContent + ", " + el?.childNodes[0].textContent;
    });
    await page.close();
    await browser.close();

    return zesti; //returning the zestimate amount
  } catch (error) {
    br?.close();
    console.log("something went wrong while scrapping", error);
  }
};

export default RunScrapper;
