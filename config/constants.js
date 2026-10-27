/**
 * Application Constants
 * Single source of truth for deities, roles, tempos, and limits
 */

const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  SINGER: "singer",
  GUEST: "guest"
};

const VALID_DEITIES = [
  "Ganesha",
  "Guru",
  "Mata",
  "SarvaDharma",
  "Sai",
  "Shiva",
  "Krishna",
  "Rama",
  "Narayana",
  "Vitthala",
  "Hanuman"
];

const DEITY_ORDER = [
  "Ganesha",
  "Guru",
  "Mata",
  "SarvaDharma",
  "Sai",
  "Shiva",
  "Krishna",
  "Rama",
  "Narayana",
  "Vitthala",
  "Hanuman"
];

const DEITY_ALIASES = {
  Vitthala: ["Vitthala", "Vittala", "Vithhala", "Vithala"],
  Vittala: ["Vitthala", "Vittala", "Vithhala", "Vithala"],
  Vithhala: ["Vitthala", "Vittala", "Vithhala", "Vithala"],
  Vithala: ["Vitthala", "Vittala", "Vithhala", "Vithala"],
  Mata: ["Mata", "Devi"],
  Devi: ["Devi", "Mata"],
  Hanuman: ["Hanuman", "Anjaneya"],
  Anjaneya: ["Hanuman", "Anjaneya"],
  SarvaDharma: ["SarvaDharma", "Sarva Dharma"],
  "Sarva Dharma": ["SarvaDharma", "Sarva Dharma"]
};

const DEITY_TITLE_MATCHERS = {
  Ganesha: /ganesh|ganapathi|ganapati|vinayaka|gajanana|lambodhara|vighneshwara/i,
  Guru: /guru|sadguru|gurudeva/i,
  Mata: /mata|devi|durga|lakshmi|laxmi|saraswati|saraswathi|bhavani|jagadambe/i,
  Devi: /mata|devi|durga|lakshmi|laxmi|saraswati|saraswathi|bhavani|jagadambe/i,
  SarvaDharma: /allah|yesu|jesus|buddha|nanak|sarva\s*dharma/i,
  "Sarva Dharma": /allah|yesu|jesus|buddha|nanak|sarva\s*dharma/i,
  Sai: /sathya\s*sai|sai\s*baba|sai\s*nath|sai\s*ram/i,
  Shiva: /shiva|shambho|shankara|mahadeva|gangadhara|nataraja|bholenath/i,
  Krishna: /krishna|gopala|gopal|govinda|govind|madhava|mukunda|nandalala|nanda\s*kishor|giridhari|radhe/i,
  Rama: /rama|raghunatha|raghupati|raghurama|ramachandra|sita\s*ram/i,
  Narayana: /narayana|narayan|vaikuntha|madhusudana|damodara|padmanabha/i,
  Vitthala: /vitt?h?ala|vithoba|pandurang/i,
  Vittala: /vitt?h?ala|vithoba|pandurang/i,
  Vithhala: /vitt?h?ala|vithoba|pandurang/i,
  Vithala: /vitt?h?ala|vithoba|pandurang/i,
  Hanuman: /hanuman|anjaneya|maruthi|maruti|pavana suta|bajrang/i,
  Anjaneya: /hanuman|anjaneya|maruthi|maruti|pavana suta|bajrang/i
};

const DEITY_TITLE_SEARCH_TERMS = {
  Ganesha: ["Ganesh", "Vinayaka", "Gajanana", "Ganapathi"],
  Guru: ["Guru", "Sadguru", "Gurudeva"],
  Mata: ["Mata", "Devi", "Durga", "Lakshmi", "Bhavani"],
  Devi: ["Mata", "Devi", "Durga", "Lakshmi", "Bhavani"],
  SarvaDharma: ["Allah", "Yesu", "Buddha", "Nanak", "Sarva Dharma"],
  "Sarva Dharma": ["Allah", "Yesu", "Buddha", "Nanak", "Sarva Dharma"],
  Sai: ["Sathya Sai", "Sai Baba", "Sai Ram", "Sai Nath"],
  Shiva: ["Shiva", "Shambho", "Shankara", "Mahadeva"],
  Krishna: ["Krishna", "Gopala", "Govinda", "Madhava", "Nandalala", "Nanda Kishora", "Giridhari"],
  Rama: ["Rama", "Raghupati", "Ramachandra", "Sita Ram"],
  Narayana: ["Narayana", "Narayan", "Vaikuntha", "Madhusudana"],
  Vitthala: ["Pandurang", "Vitt", "Vith", "Vitthala"],
  Vittala: ["Pandurang", "Vitt", "Vith", "Vitthala"],
  Vithhala: ["Pandurang", "Vitt", "Vith", "Vitthala"],
  Vithala: ["Pandurang", "Vitt", "Vith", "Vitthala"],
  Hanuman: ["Hanuman", "Anjaneya", "Maruthi", "Maruti", "Pavana Suta", "Bajrang"],
  Anjaneya: ["Hanuman", "Anjaneya", "Maruthi", "Maruti", "Pavana Suta", "Bajrang"]
};

const SPEED_VALUES = ["Slow", "Medium", "Fast"];

const DEFAULT_DEITY_LIMITS = {
  min_required: 0,
  max_allowed: 2
};

const PIN_LOCKOUT_CONFIG = {
  MAX_FAILURES: 5,
  LOCKOUT_MS: 15 * 60 * 1000 // 15 minutes
};

module.exports = {
  ROLES,
  VALID_DEITIES,
  DEITY_ORDER,
  DEITY_ALIASES,
  DEITY_TITLE_MATCHERS,
  DEITY_TITLE_SEARCH_TERMS,
  SPEED_VALUES,
  DEFAULT_DEITY_LIMITS,
  PIN_LOCKOUT_CONFIG
};
