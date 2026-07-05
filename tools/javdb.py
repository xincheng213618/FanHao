import requests
from bs4 import BeautifulSoup
from project_paths import resolve_shared_browser_profile_dir
import logging
import time

LOGGER = logging.getLogger("javdb")

javlibrary_search_url = "https://javdb.com/search"

javlibrary_cookie = "locale=zh; _ym_uid=1743432317221724263; _ym_d=1743432317; over18=1; comment_warning=1; list_mode=h; theme=auto; cf_clearance=9qgJtM_XN_GJ0DTgzwclE9Gvk1MRJ3Bhcq093gKsRug-1770464811-1.2.1.1-DZqOdQmeutKvkXHXn_DPpcoKXb1TcoUl10SGPTbnysum3qSp4pZTWvQ6pxfLKlnb5wlEt0oGTt5DAcqztwrluJrX36Wkw0VGceAFAsdFyPVfdDckU6W7WAfmcucoFj4XYQkZBLCTpAZDeb6TKYdqDYK8pQiQ4SvpZfzbrnlb3ADPAu2gZ1WM9SMZiCTxsfQMpseFtgit7z6euU1PFStf7GLlV56.BIX6Z47QJWCRwYs; _jdb_session=ZE3NJqSNekIdLFMJkC0MHRonl6%2B6mAhwYkBJ87UReSdm0w02DbPz96fvubw20J%2Fjf9L7SmiadLZ1HXCfULbpXJ%2FqYn2OU0y0nyZHdZgIwwEE%2BMAYFsY0N8vyYm2RCXrgngGhZxCyKRwDG3Tj%2FMnaOGyImk7GuXQ2HibAF2WXExZ3F72RYiUoN6eJJFso4C5itAYxMIr9nNtdc8pyZavI8eFSfyzMddZ3Kjl6GT0GKk0Dtm70483o0an4epgUoU2SnRVbMCTndgszYByK67Js8VgX%2FNM55kBdLrzoqsvGTbNeq8qhgeSyFgBKitw0PfWgkb%2FwMphvwXR4lvd%2BOXUDXMZ%2F%2FZ0YXNnsgoJFbiRXHK6C%2FSWbLo2i07FXrhuR%2FIofCPVsHC8stYvwkMxCtY6yECIx7bVstslDQRQi%2FolYa9A7g1QAXAN51v2pFr4Zr94Qc4LFJQbwINUim6eSXGAy7huSalC%2BBQ%3D%3D--frWwb32UfPkWrq4C--imONhbcvt1gZUurOENdQdQ%3D%3D"
proxies = {
    "https": "http://127.0.0.1:10809"
}

headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36",
    "cookie": javlibrary_cookie
}
import re
PAGE_DELAY_SECONDS = 2.0


def normalize_code(code):
    if not code:
        return ""
    # Use regular expression to remove leading zeros from the numeric part
    return re.sub(r'(\D+)-?0*(\d+)', r'\1-\2', code)


driver = None


def _build_driver(user_data_dir):

    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.chrome.options import Options
    from webdriver_manager.chrome import ChromeDriverManager
    from selenium_stealth import stealth

    """初始化标准 Selenium Driver 并注入 Stealth 伪装"""
    chrome_options = Options()

    # 基础反爬设置
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--remote-debugging-port=0")
    chrome_options.add_argument("--window-size=1280,900")

    chrome_options.add_argument(f"--user-data-dir={user_data_dir}")
    # 关键：禁用自动化标志
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    chrome_options.add_experimental_option('useAutomationExtension', False)

    # 如果需要无头模式（不显示浏览器窗口），请取消下面这行的注释
    # chrome_options.add_argument("--headless=new")

    # 设置代理
    chrome_options.add_argument(f'--proxy-server=http://127.0.0.1:10809')

    # 初始化 Driver
    service = ChromeService(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)

    # 启用 Stealth 模式 (这是绕过 Cloudflare 的关键)
    stealth(driver,
            languages=["zh-cn","zh"],
            vendor="Google Inc.",
            platform="Win32",
            webgl_vendor="Intel Inc.",
            renderer="Intel Iris OpenGL Engine",
            fix_hairline=True,
            )

    return driver


def get_driver():
    global driver
    if driver is not None:
        try:
            driver.current_url
            return driver
        except Exception:
            try:
                driver.quit()
            except Exception:
                pass
            driver = None

    user_data_dir = resolve_shared_browser_profile_dir().resolve()
    LOGGER.info("Using Chrome profile: %s", user_data_dir)
    try:
        driver = _build_driver(user_data_dir)
        return driver
    except Exception as e:
        raise RuntimeError(f"JavDB Chrome driver startup failed. profile={user_data_dir}; error={e}") from e


def getletterinfo(query):

    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    active_driver = get_driver()

    url = f"{javlibrary_search_url}?q={query}&f=all"
    LOGGER.info("Open JavDB search: %s", query)
    active_driver.get(url)

    WebDriverWait(active_driver, 30).until(
        EC.presence_of_element_located((By.CLASS_NAME, "movie-list"))
    )

    search_list = []
    for item in active_driver.find_elements(By.CSS_SELECTOR, ".movie-list .item"):
        try:
            a_tag = item.find_element(By.CSS_SELECTOR, "a.box")
            href_value = a_tag.get_attribute("href")
            strong_text = item.find_element(By.CSS_SELECTOR, "strong").text.strip()
            video_title = item.find_element(By.CSS_SELECTOR, ".video-title").text.strip()
        except Exception:
            continue
        if not href_value or not strong_text:
            continue
        info = {
            "href_value": href_value,
            "strong_text": strong_text,
            "video_title": video_title,
        }
        search_list.append(info)
        LOGGER.debug("JavDB candidate code=%s href=%s", strong_text, href_value)

    for info in search_list:

        if (normalize_code(query).lower() in normalize_code(info.get("strong_text")).lower()) or  (normalize_code(info.get("strong_text")).lower() in normalize_code(query).lower() ) :
            LOGGER.info("Open JavDB detail: %s", info.get("strong_text"))
            time.sleep(PAGE_DELAY_SECONDS)
            active_driver.get(info["href_value"])
            WebDriverWait(active_driver, 30).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "h2.title"))
            )

            browser_title = re.sub(r"\s*\|\s*JavDB.*$", "", active_driver.title or "").strip()
            h2_tags = active_driver.find_elements(By.CSS_SELECTOR, "h2.title")
            if not h2_tags:
                continue
            h2_tag = h2_tags[0]
            strong_texts = [
                tag.text.strip()
                for tag in h2_tag.find_elements(By.CSS_SELECTOR, "strong")
                if tag.text.strip()
            ]

            videoinfo = {}
            video_id = strong_texts[0] if strong_texts else info.get("strong_text")
            videoinfo["detail_url"] = info["href_value"]
            if browser_title:
                first_word = browser_title.split(maxsplit=1)[0]
                if normalize_code(first_word).lower() == normalize_code(query).lower():
                    video_id = first_word
            videoinfo['video_id'] = video_id

            if browser_title:
                videoinfo['video_title'] = browser_title
            else:
                title_text = None
                origin_titles = h2_tag.find_elements(By.CSS_SELECTOR, ".origin-title")
                if origin_titles and origin_titles[0].text.strip():
                    title_text = origin_titles[0].text.strip()
                elif len(strong_texts) > 1:
                    title_text = strong_texts[1]
                else:
                    h2_text = h2_tag.text.strip()
                    title_text = re.sub(rf"^{re.escape(video_id or '')}\s*", "", h2_text).strip()
                videoinfo['video_title'] = f"{video_id} {title_text}".strip() if title_text else video_id

            actor_names = []
            for label in ("演員:", "演员:"):
                actor_spans = active_driver.find_elements(By.XPATH, f"//strong[normalize-space()='{label}']/following-sibling::span[1]")
                if actor_spans:
                    actor_names = [
                        actor.text.strip()
                        for actor in actor_spans[0].find_elements(By.CSS_SELECTOR, "a")
                        if actor.text.strip()
                    ]
                    break
            if browser_title and (not actor_names or any("�" in actor for actor in actor_names)):
                title_without_code = re.sub(rf"^{re.escape(video_id or '')}\s*", "", browser_title).strip()
                title_parts = title_without_code.split()
                if len(title_parts) >= 2 and len(title_parts[-1]) <= 12:
                    actor_names = [re.sub(r"【[^】]*】$", "", title_parts[-1]).strip()]
                else:
                    actor_names = []
            videoinfo['actor_names'] = actor_names

            def label_value(*labels):
                for label in labels:
                    spans = active_driver.find_elements(By.XPATH, f"//strong[normalize-space()='{label}']/following-sibling::span[1]")
                    if spans and spans[0].text.strip():
                        return spans[0].text.strip()
                return None

            videoinfo['发行日期'] = label_value("日期:")
            videoinfo['长度'] = label_value("時長:", "时长:")
            videoinfo['rating'] = label_value("評分:", "评分:")

            cover_tags = active_driver.find_elements(By.CSS_SELECTOR, "img.video-cover")
            image_url = cover_tags[0].get_attribute("src") if cover_tags else None
            if not image_url:
                return videoinfo
            videoinfo['image_url'] = image_url if image_url.startswith(
                'http') else f"https://c0.jdbstatic.com{image_url}"
            return videoinfo
