const { Router } = require("express");
const pool = require("../db");

const router = Router();

const VALID_SORT_BY = ["age", "created_at", "gender_probability"];
const VALID_ORDER = ["asc", "desc"];
const VALID_GENDERS = ["male", "female"];
const VALID_AGE_GROUPS = ["child", "teenager", "adult", "senior"];

function isFloat(val) {
  return /^-?\d+(\.\d+)?$/.test(val);
}

function isPositiveInt(val) {
  return /^\d+$/.test(val) && parseInt(val, 10) > 0;
}

function isNonNegativeInt(val) {
  return /^\d+$/.test(val);
}

// GET /api/profiles
router.get("/", async (req, res) => {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by = "created_at",
    order = "asc",
    page = "1",
    limit = "10",
  } = req.query;

  if (gender !== undefined && !VALID_GENDERS.includes(gender)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (age_group !== undefined && !VALID_AGE_GROUPS.includes(age_group)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (!VALID_SORT_BY.includes(sort_by)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (!VALID_ORDER.includes(order)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (min_age !== undefined && !isNonNegativeInt(min_age)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (max_age !== undefined && !isNonNegativeInt(max_age)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (min_gender_probability !== undefined && !isFloat(min_gender_probability)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (min_country_probability !== undefined && !isFloat(min_country_probability)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (!isPositiveInt(page)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (!isPositiveInt(limit)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }

  const pageNum = parseInt(page, 10);
  let limitNum = Math.min(parseInt(limit, 10), 50);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (gender) { conditions.push(`gender = $${idx++}`); values.push(gender); }
  if (age_group) { conditions.push(`age_group = $${idx++}`); values.push(age_group); }
  if (country_id) { conditions.push(`country_id = $${idx++}`); values.push(country_id.toUpperCase()); }
  if (min_age !== undefined) { conditions.push(`age >= $${idx++}`); values.push(parseInt(min_age, 10)); }
  if (max_age !== undefined) { conditions.push(`age <= $${idx++}`); values.push(parseInt(max_age, 10)); }
  if (min_gender_probability !== undefined) { conditions.push(`gender_probability >= $${idx++}`); values.push(parseFloat(min_gender_probability)); }
  if (min_country_probability !== undefined) { conditions.push(`country_probability >= $${idx++}`); values.push(parseFloat(min_country_probability)); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortCol = sort_by === "gender_probability" ? "gender_probability" : sort_by === "age" ? "age" : "created_at";
  const orderClause = `ORDER BY ${sortCol} ${order.toUpperCase()}`;

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM profiles ${where}`, values);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM profiles ${where} ${orderClause}
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limitNum, offset]
    );

    return res.json({ status: "success", page: pageNum, limit: limitNum, total, data: dataResult.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

// ---- Natural Language Parser ----

const COUNTRY_MAP = {
  nigeria: "NG", ghana: "GH", kenya: "KE", ethiopia: "ET", tanzania: "TZ",
  uganda: "UG", rwanda: "RW", mozambique: "MZ", angola: "AO", zambia: "ZM",
  malawi: "MW", zimbabwe: "ZW", "south africa": "ZA", mali: "ML", senegal: "SN",
  cameroon: "CM", "ivory coast": "CI", "cote d'ivoire": "CI", "côte d'ivoire": "CI",
  gabon: "GA", "democratic republic of the congo": "CD", "dr congo": "CD",
  congo: "CG", "republic of the congo": "CG", sudan: "SD", morocco: "MA",
  madagascar: "MG", namibia: "NA", eritrea: "ER", gambia: "GM",
  "cape verde": "CV", "burkina faso": "BF", "guinea-bissau": "GW", guinea: "GN",
  benin: "BJ", togo: "TG", niger: "NE", chad: "TD",
  "central african republic": "CF", somalia: "SO", djibouti: "DJ", comoros: "KM",
  mauritius: "MU", "sierra leone": "SL", liberia: "LR",
  "equatorial guinea": "GQ", burundi: "BI", "south sudan": "SS",
  egypt: "EG", libya: "LY", tunisia: "TN", algeria: "DZ",
  india: "IN", brazil: "BR", france: "FR", "united kingdom": "GB",
  uk: "GB", "united states": "US", usa: "US",
};

function parseNaturalLanguage(q) {
  const lower = q.toLowerCase().trim();
  if (!lower) return null;

  const filters = {};
  let matched = false;

  // Gender
  if (/\bmales?\b/.test(lower) && !/\bfemales?\b/.test(lower)) {
    filters.gender = "male"; matched = true;
  } else if (/\bfemales?\b/.test(lower)) {
    filters.gender = "female"; matched = true;
  } else if (/\bwomen\b|\bwoman\b|\bgirls?\b/.test(lower)) {
    filters.gender = "female"; matched = true;
  } else if (/\bmen\b|\bman\b|\bboys?\b/.test(lower)) {
    filters.gender = "male"; matched = true;
  }

  // "male and female" = no gender filter
  if (/\bmale and female\b|\bfemale and male\b|\bboth\b/.test(lower)) {
    delete filters.gender;
  }

  // Age group
  if (/\bchildren\b|\bchild\b|\bkids?\b/.test(lower)) {
    filters.age_group = "child"; matched = true;
  } else if (/\bteenagers?\b|\bteens?\b/.test(lower)) {
    filters.age_group = "teenager"; matched = true;
  } else if (/\badults?\b/.test(lower)) {
    filters.age_group = "adult"; matched = true;
  } else if (/\bseniors?\b|\belderly\b|\bold people\b/.test(lower)) {
    filters.age_group = "senior"; matched = true;
  }

  // "young" = ages 16-24 (parsing only)
  if (/\byoung\b/.test(lower) && !filters.age_group) {
    filters.min_age = 16; filters.max_age = 24; matched = true;
  }

  // above / over / older than
  const aboveMatch = lower.match(/(?:above|over|older than|more than|greater than)\s+(\d+)/);
  if (aboveMatch) { filters.min_age = parseInt(aboveMatch[1], 10); matched = true; }

  // below / under / younger than
  const belowMatch = lower.match(/(?:below|under|younger than|less than)\s+(\d+)/);
  if (belowMatch) { filters.max_age = parseInt(belowMatch[1], 10); matched = true; }

  // between X and Y
  const betweenMatch = lower.match(/between\s+(\d+)\s+and\s+(\d+)/);
  if (betweenMatch) {
    filters.min_age = parseInt(betweenMatch[1], 10);
    filters.max_age = parseInt(betweenMatch[2], 10);
    matched = true;
  }

  // aged X
  const agedMatch = lower.match(/\baged?\s+(\d+)/);
  if (agedMatch) {
    const age = parseInt(agedMatch[1], 10);
    filters.min_age = age; filters.max_age = age; matched = true;
  }

  // Country (longest match first)
  const sortedCountries = Object.entries(COUNTRY_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [name, code] of sortedCountries) {
    if (lower.includes(name)) {
      filters.country_id = code; matched = true; break;
    }
  }

  return matched ? filters : null;
}

// GET /api/profiles/search
router.get("/search", async (req, res) => {
  const { q, page = "1", limit = "10" } = req.query;

  if (!q || q.trim() === "") {
    return res.status(400).json({ status: "error", message: "Missing or empty parameter" });
  }
  if (!isPositiveInt(page)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }
  if (!isPositiveInt(limit)) {
    return res.status(422).json({ status: "error", message: "Invalid query parameters" });
  }

  const filters = parseNaturalLanguage(q);
  if (!filters) {
    return res.status(200).json({ status: "error", message: "Unable to interpret query" });
  }

  const pageNum = parseInt(page, 10);
  let limitNum = Math.min(parseInt(limit, 10), 50);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (filters.gender) { conditions.push(`gender = $${idx++}`); values.push(filters.gender); }
  if (filters.age_group) { conditions.push(`age_group = $${idx++}`); values.push(filters.age_group); }
  if (filters.country_id) { conditions.push(`country_id = $${idx++}`); values.push(filters.country_id); }
  if (filters.min_age !== undefined) { conditions.push(`age >= $${idx++}`); values.push(filters.min_age); }
  if (filters.max_age !== undefined) { conditions.push(`age <= $${idx++}`); values.push(filters.max_age); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM profiles ${where}`, values);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM profiles ${where} ORDER BY created_at ASC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limitNum, offset]
    );

    return res.json({ status: "success", page: pageNum, limit: limitNum, total, data: dataResult.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: "error", message: "Server error" });
  }
});

module.exports = router;
