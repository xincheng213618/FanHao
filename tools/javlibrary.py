import requests
from bs4 import BeautifulSoup

javlibrary_search_url = "https://www.javlibrary.com/cn/vl_searchbyid.php?keyword="

javlibrary_cookie = "timezone=-480; dm=javlibrary; cf_clearance=JZQ3WX.lv8WxaFrHQmqtICNh3qh1zcp5Zu3ZWZuImHE-1710561619-1.0.1.1-_RNeskDrpnMp42iAmC.WPZm9sN9xFhKvFwgdoEadqNthrlbK3UFXcAheIMqkXwzPM0cnSBdMKTIS1dQrcqEubA; over18=18"

proxies = {
    "https": "http://127.0.0.1:10809"
}

headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36",
    "cookie": javlibrary_cookie
}


def getletterinfo(letter):
    new_url = javlibrary_search_url + letter
    print(f"正在解析 javlibrary {new_url}")
    video_info = {}

    r = requests.get(new_url, headers=headers, proxies=proxies, timeout=15)
    soup = BeautifulSoup(r.text, 'html.parser')

    try:
        # 查找id为"video_title"的div标签内的a标签
        video_title_a_tag = soup.find('div', id='video_title').find('a')
        # 获取a标签的文本内容
        video_title = video_title_a_tag.get_text(strip=True)
        print(video_title)
    except:
        print(f"找不到{new_url}的相关信息")
        return video_info

    actors = soup.find_all('span', class_='cast')

    # 提取并打印所有演员的名字
    actor_names = []
    for actor in actors:
        # 找到<a>标签并获取其文本内容
        name_tag = actor.find('a')
        if name_tag:
            actor_names.append(name_tag.get_text())

    img_tag = soup.find('img', id='video_jacket_img')

    # 提取src属性
    image_url = img_tag['src'] if img_tag else None

    video_info['video_title'] = video_title
    video_info['image_url'] = image_url

    # 提取信息
    video_info['识别码'] = soup.find('td', text='识别码:').find_next_sibling('td').text
    video_info['发行日期'] = soup.find('td', text='发行日期:').find_next_sibling('td').text
    video_info['长度'] = soup.find('td', text='长度:').find_next_sibling('td').text.strip() + '分钟'
    video_info['导演'] = soup.find('td', text='导演:').find_next_sibling('td').text.strip()
    video_info['制作商'] = soup.find('td', text='制作商:').find_next_sibling('td').text.strip()
    video_info['发行商'] = soup.find('td', text='发行商:').find_next_sibling('td').text.strip()

    video_info['actor_names'] = actor_names;

    return video_info
