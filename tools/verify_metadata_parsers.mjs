import { parseInfoMetadata, renderInfoMetadataText, scoreInfoFile } from "../lib/info-metadata.js";

const CASES = [
  {
    name: "Kodi/Jellyfin NFO with actors, tags, set and JavDB URL",
    input: `
      <?xml version="1.0" encoding="utf-8"?>
      <movie>
        <num>SSNI00644</num>
        <title>Test & Title</title>
        <originaltitle>Original Test Title</originaltitle>
        <sorttitle>SSNI00644 Test Sort</sorttitle>
        <premiered>2025-01-02</premiered>
        <year>2025</year>
        <runtime>125 min</runtime>
        <rating>4.2</rating>
        <criticrating>84</criticrating>
        <votes>58</votes>
        <mpaa>JP-18+</mpaa>
        <country>日本</country>
        <wanted>321</wanted>
        <director>Director A</director>
        <studio>PRESTIGE</studio>
        <label>Label A</label>
        <set><name>Series A</name></set>
        <plot><![CDATA[A compact story summary.]]></plot>
        <uniqueid type="javdb">https://javdb.com/v/abc123</uniqueid>
        <thumb>https://img.example.test/cover.jpg</thumb>
        <thumb>https://img.example.test/sample-1.jpg</thumb>
        <trailer>https://video.example.test/trailer.mp4</trailer>
        <actor><name>Actor One</name></actor>
        <actor><name>Actor One</name></actor>
        <actress>Actor Two、Actor Three</actress>
        <genre>Drama</genre>
        <genre>Drama</genre>
        <tag>VR</tag>
      </movie>
    `,
    expected: {
      code: "SSNI-644",
      title: "Test & Title",
      originalTitle: "Original Test Title",
      sortTitle: "SSNI00644 Test Sort",
      releaseDate: "2025-01-02",
      year: "2025",
      durationMinutes: 125,
      rating: 4.2,
      ratingCount: 58,
      criticRating: "84",
      contentRating: "JP-18+",
      country: "日本",
      wanted: "321",
      director: "Director A",
      maker: "PRESTIGE",
      label: "Label A",
      series: "Series A",
      description: "A compact story summary.",
      javdbUrl: "https://javdb.com/v/abc123",
      imageUrl: "https://img.example.test/cover.jpg",
      previewImages: ["https://img.example.test/sample-1.jpg"],
      previewVideoUrl: "https://video.example.test/trailer.mp4",
      actors: ["Actor One", "Actor Two", "Actor Three"],
      tags: ["Drama", "VR"]
    }
  },
  {
    name: "NFO named JavDB rating outranks generic ratings",
    input: `
      <movie>
        <num>ABP-222</num>
        <title>Named rating case</title>
        <rating>8.4</rating>
        <votes>999</votes>
        <ratings>
          <rating name="imdb" max="10">
            <value>6.2</value>
            <votes>11</votes>
          </rating>
          <rating name="jdb" max="5" default="true">
            <value>4.6</value>
            <votes>321</votes>
          </rating>
        </ratings>
      </movie>
    `,
    expected: {
      code: "ABP-222",
      title: "Named rating case",
      rating: 4.6,
      ratingCount: 321
    },
    expectedField: { label: "评分", value: "4.6 分，321 人评价" }
  },
  {
    name: "Plain text metadata with aliases and list fields",
    input: `
      video_id: FC2-PPV-001234567
      video_title: FC2 sample title
      release_date: 2024/03/04
      year: 2024
      duration: 130 minutes
      rating: 4.5, 123 users
      mpaa: JP-18+
      maker: Maker A
      outline: Plain text story summary.
      actor_names: Airi, Ema、Mio
      tags: Indie, Drama, Indie
      preview_images: https://img.example.test/a.jpg, https://img.example.test/a.jpg, https://img.example.test/b.jpg
      preview_video_url: https://video.example.test/fc2.webm
      javdb_url: https://javdb.com/v/fc2
    `,
    expected: {
      code: "FC2-PPV-1234567",
      title: "FC2 sample title",
      releaseDate: "2024-03-04",
      year: "2024",
      durationMinutes: 130,
      rating: 4.5,
      ratingCount: 123,
      contentRating: "JP-18+",
      maker: "Maker A",
      description: "Plain text story summary.",
      javdbUrl: "https://javdb.com/v/fc2",
      previewImages: ["https://img.example.test/a.jpg", "https://img.example.test/b.jpg"],
      previewVideoUrl: "https://video.example.test/fc2.webm",
      actors: ["Airi", "Ema", "Mio"],
      tags: ["Indie", "Drama"]
    }
  },
  {
    name: "JSON metadata object",
    input: JSON.stringify({
      code: "HEYZO_0123",
      title: "HEYZO title",
      originaltitle: "HEYZO original title",
      date: "2023-11-09",
      year: "2023",
      runtime: "88 min",
      score: "3.8 from 42 users",
      country: "日本",
      studio: "Studio B",
      series: "Series B",
      description: "JSON story summary.",
      actors: ["Alice", "Alice", "Betty"],
      genres: ["Solo", "POV", "Solo"],
      image_url: "https://img.example.test/heyzo.jpg",
      sample_images: ["https://img.example.test/heyzo-1.jpg", "https://img.example.test/heyzo-1.jpg"],
      trailer: "https://video.example.test/heyzo.m3u8"
    }),
    expected: {
      code: "HEYZO-123",
      title: "HEYZO title",
      originalTitle: "HEYZO original title",
      releaseDate: "2023-11-09",
      year: "2023",
      durationMinutes: 88,
      rating: 3.8,
      ratingCount: 42,
      country: "日本",
      maker: "Studio B",
      series: "Series B",
      description: "JSON story summary.",
      imageUrl: "https://img.example.test/heyzo.jpg",
      previewImages: ["https://img.example.test/heyzo-1.jpg"],
      previewVideoUrl: "https://video.example.test/heyzo.m3u8",
      actors: ["Alice", "Betty"],
      tags: ["Solo", "POV"]
    }
  },
  {
    name: "NFO actor thumbs are excluded from work media",
    input: `
      <movie>
        <num>ABP-123</num>
        <title>Actor thumb case</title>
        <actor>
          <name>Actor One</name>
          <thumb>https://img.example.test/actor-one.jpg</thumb>
        </actor>
        <thumb>https://img.example.test/cover-abp.jpg</thumb>
        <fanart>
          <thumb>https://img.example.test/sample-abp-1.jpg</thumb>
        </fanart>
      </movie>
    `,
    expected: {
      code: "ABP-123",
      title: "Actor thumb case",
      imageUrl: "https://img.example.test/cover-abp.jpg",
      previewImages: ["https://img.example.test/sample-abp-1.jpg"],
      actors: ["Actor One"]
    }
  },
  {
    name: "NFO actor-only tags are removed from categories",
    input: `
      <movie>
        <num>ABP-124</num>
        <title>Actor tag cleanup case</title>
        <actor><name>Actor One</name></actor>
        <actor><name>Actor Two</name></actor>
        <tag>Actor One</tag>
        <tag>Drama</tag>
        <genre>Actor Two</genre>
        <genre>VR</genre>
      </movie>
    `,
    expected: {
      code: "ABP-124",
      title: "Actor tag cleanup case",
      actors: ["Actor One", "Actor Two"],
      tags: ["VR", "Drama"]
    }
  },
  {
    name: "NFO poster thumb outranks fanart thumb",
    input: `
      <movie>
        <num>ABP-789</num>
        <title>Poster thumb case</title>
        <fanart>
          <thumb aspect="fanart">https://img.example.test/sample-a.jpg</thumb>
        </fanart>
        <thumb aspect="fanart">https://img.example.test/sample-b.jpg</thumb>
        <thumb aspect="poster">https://img.example.test/poster-abp.jpg</thumb>
      </movie>
    `,
    expected: {
      code: "ABP-789",
      title: "Poster thumb case",
      imageUrl: "https://img.example.test/poster-abp.jpg",
      previewImages: ["https://img.example.test/sample-a.jpg", "https://img.example.test/sample-b.jpg"]
    }
  },
  {
    name: "NFO secondary cover is kept as preview image",
    input: `
      <movie>
        <num>ABP-790</num>
        <title>Poster and cover case</title>
        <poster>https://img.example.test/poster-abp790.jpg</poster>
        <cover>https://img.example.test/cover-abp790.jpg</cover>
      </movie>
    `,
    expected: {
      code: "ABP-790",
      title: "Poster and cover case",
      imageUrl: "https://img.example.test/poster-abp790.jpg",
      previewImages: ["https://img.example.test/cover-abp790.jpg"]
    }
  },
  {
    name: "NFO script and style blocks are ignored",
    input: `
      <movie>
        <num>REAL-777</num>
        <title>Clean NFO</title>
        <script>
          window.badCode = "BAD-999";
          window.badPreview = "https://video.example.test/bad-preview.mp4";
          window.badJavdb = "https://javdb.com/v/bad";
        </script>
        <style>.cover { background: url("https://img.example.test/bad-style.jpg"); }</style>
      </movie>
    `,
    expected: {
      code: "REAL-777",
      title: "Clean NFO",
      javdbUrl: "",
      imageUrl: "",
      previewImages: [],
      previewVideoUrl: ""
    }
  },
  {
    name: "NFO external ids do not become work codes",
    input: `
      <movie>
        <id>tt1234567</id>
        <title>Real Title</title>
        <uniqueid type="tmdb">7654321</uniqueid>
      </movie>
    `,
    defaults: { title: "Fallback", directoryName: "ABP-123 Folder" },
    expected: {
      code: "ABP-123",
      title: "Real Title"
    }
  },
  {
    name: "NFO generic id still supports real work codes",
    input: `
      <movie>
        <id>ABP-123</id>
        <title>Generic id code</title>
      </movie>
    `,
    expected: {
      code: "ABP-123",
      title: "Generic id code"
    }
  },
  {
    name: "NFO JavDB search id can supply work code",
    input: `
      <movie>
        <title>MDCx JavDB search id case</title>
        <javdbsearchid>ssni00644</javdbsearchid>
      </movie>
    `,
    expected: {
      code: "SSNI-644",
      title: "MDCx JavDB search id case"
    }
  },
  {
    name: "NFO JavDB short external id becomes URL",
    input: `
      <movie>
        <num>ABP-791</num>
        <title>MDCx JavDB id case</title>
        <javdbid>D16Q5</javdbid>
      </movie>
    `,
    expected: {
      code: "ABP-791",
      title: "MDCx JavDB id case",
      javdbUrl: "https://javdb.com/v/D16Q5"
    }
  },
  {
    name: "NFO invalid numeric entities do not crash parsing",
    input: `
      <movie>
        <num>ABP-456</num>
        <title>Safe &#x26; Broken &#99999999;</title>
      </movie>
    `,
    expected: {
      code: "ABP-456",
      title: "Safe & Broken &#99999999;"
    }
  },
  {
    name: "Subtitle-like text is not treated as metadata",
    input: `[Script Info]
ScriptType: v4.00+
[Events]
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,hello`,
    subtitleLike: true
  }
];

const failures = [];

for (const testCase of CASES) {
  if (testCase.subtitleLike) {
    const parsed = parseInfoMetadata(testCase.input, { title: "fallback title" });
    assertEqual(`${testCase.name} inferred fallback title`, parsed.title, "fallback title");
    assertEqual(`${testCase.name} code`, parsed.code, "");
    assertEqual(`${testCase.name} actors`, parsed.actors, []);
    assertEqual(`${testCase.name} tags`, parsed.tags, []);
    continue;
  }

  const parsed = parseInfoMetadata(testCase.input, testCase.defaults || { title: "fallback title", directoryName: "Fallback" });
  for (const [key, expectedValue] of Object.entries(testCase.expected)) {
    assertEqual(`${testCase.name} ${key}`, parsed[key], expectedValue);
  }
  if (testCase.expectedField && !parsed.fields?.some((field) => field.label === testCase.expectedField.label && field.value === testCase.expectedField.value)) {
    failures.push(`${testCase.name} field ${testCase.expectedField.label}: expected ${testCase.expectedField.value}`);
  }

  const rendered = renderInfoMetadataText(parsed);
  if (!rendered.includes(`番号: ${testCase.expected.code}`)) {
    failures.push(`${testCase.name} render includes code`);
  }
  if (!parsed.fields?.length) {
    failures.push(`${testCase.name} public fields should not be empty`);
  }
}

assertEqual("info.nfo outranks subtitle", scoreInfoFile({ name: "movie.nfo", ext: ".nfo", size: 1000 }) > scoreInfoFile({ name: "movie.srt", ext: ".srt", size: 1000 }), true);
assertEqual("info.json gets strong score", scoreInfoFile({ name: "info.json", ext: ".json", size: 1000 }) > scoreInfoFile({ name: "random.txt", ext: ".txt", size: 1000 }), true);

if (failures.length) {
  console.error(`metadata parser verification failed (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`metadata parser verification passed (${CASES.length} cases)`);

function assertEqual(label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    failures.push(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}
