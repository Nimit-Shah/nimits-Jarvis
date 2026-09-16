/**
 * Starwood Events & Entertainment — Editorial Content & Brand Data Model
 * Source of Truth: Starwood Events & Entertainment General Pitch Deck & Brochure
 */

export const BRAND = {
  name: "Starwood Events & Entertainment",
  shortName: "Starwood Events",
  tagline: "Your Vision, Our Execution",
  quote: "We don’t just organise celebrations. We create the moments people remember.",
  since: 2012,
  address: "Tirandaz, Powai, Opp. IIT Bombay Gate, Mumbai 400076",
  phones: ["+91 98679 32747", "+91 97691 44801"],
  email: "sameer@starwoodevents.com",
  instagram: "https://instagram.com/starwood.events",
  website: "https://www.starwoodevents.com"
};

export const PROOF_METRICS = [
  { label: "Established", value: "2012", detail: "Serving Mumbai & Thane" },
  { label: "Curated Events", value: "200+", detail: "Across Western, Central & Harbour lines" },
  { label: "Retained Clients", value: "50+", detail: "Year-over-year repeat celebrations" },
  { label: "Client Referral", value: "High Rate", detail: "Word-of-mouth trust and transparency" }
];

export const FOUNDERS = [
  {
    name: "Sameer Khan",
    role: "Founder · Creative Director",
    image: "founder-sameer-khan.jpg",
    bio: "Pioneering creative concepts, immersive stage atmospheres, and bespoke client experiences since 2012."
  },
  {
    name: "Nimit Shah",
    role: "Founder · Operations Director",
    image: "founder-nimit-shah.jpg",
    bio: "Leading precision on-site execution, vendor networks, timeline discipline, and seamless floor management."
  }
];

export const PHILOSOPHY = [
  { step: "01", text: "Go the extra mile on every production." },
  { step: "02", text: "Punctuality is non-negotiable commitment." },
  { step: "03", text: "Advise what is best, current & feasible." },
  { step: "04", text: "Respect the genuine value of money." },
  { step: "05", text: "A delighted guest is a successful event." }
];

export const CELEBRATIONS = [
  {
    id: "corporate",
    category: "Corporate",
    title: "Corporate Events",
    description: "Keynotes, annual awards galas, shareholder summits, and product unveilings. Punctual, stage-managed, documented run-sheets, and spotless AV delivery.",
    image: "cat-corporate.jpg",
    features: [
      "Stage & Lighting Trusses",
      "Conference Audio & Anchors",
      "Documented Run-Sheets"
    ]
  },
  {
    id: "weddings",
    category: "Weddings",
    title: "Weddings",
    description: "Complete multi-day wedding celebrations. Stage design, varmala choreography, sangeet production, guest seating, sound systems, and dedicated family floor management.",
    image: "cat-wedding.jpg",
    features: [
      "Bespoke Mandap Décor",
      "Sangeet Choreography & DJ",
      "Family Floor Concierge"
    ]
  },
  {
    id: "social",
    category: "Social Celebrations",
    title: "Social Events",
    description: "Milestone birthdays, intimate baby showers, silver anniversaries, and family reunions. In-house props, thematic setups, engaging anchors, and curated hospitality.",
    image: "cat-social.jpg",
    features: [
      "Theme Styling & Backdrops",
      "Anchors & Games Flow",
      "DJ & Sound Systems"
    ]
  },
  {
    id: "property",
    category: "Property & Expos",
    title: "Property Events",
    description: "Real estate launch pavilions, builder expos, high-net-worth investor previews, and experience centers. Precision fabrication, spatial branding, and VIP protocol.",
    image: "cat-property.jpg",
    features: [
      "Custom Stall Fabrication",
      "Spatial Lighting & Branding",
      "VIP Hospitality Management"
    ]
  }
];

export const SERVICES = [
  {
    num: "01",
    title: "Anchors & Emcees",
    description: "Multilingual professional hosts who guide celebration tempo, audience interaction, and seamless transitions."
  },
  {
    num: "02",
    title: "Program Itinerary & Flow",
    description: "Chronological schedules, cue sheets, and production run-sheets distributed to all event partners."
  },
  {
    num: "03",
    title: "Cinematographers & Photographers",
    description: "Editorial photojournalism, candid portraiture, drone cinematography, and live multi-cam stage feeds."
  },
  {
    num: "04",
    title: "Choreographers & Artists",
    description: "Tailored sangeet choreography, celebrity performers, live acoustic bands, Sufi musicians, and dance troupes."
  },
  {
    num: "05",
    title: "Food & Beverage Sourcing",
    description: "Curated gourmet caterers, bespoke mocktail/cocktail bars, themed dining concepts, and hospitality staff."
  },
  {
    num: "06",
    title: "Décor, Props & Truss Lighting",
    description: "In-house decorative materials, stage trusses, ambient architectural washes, and floral craftsmanship."
  }
];

export const STORIES = [
  {
    category: "Milestone Birthday · Mumbai",
    title: "Full-Package Birthday",
    description: "Complete sensory transformation for an unforgettable celebration. High-fidelity sound systems, engaging anchor, curated balloon and lighting themes, and an attentive floor captain managing guest flow.",
    scope: "Sound · Host · Décor · Floor Management"
  },
  {
    category: "Luxury Wedding · Mumbai & Thane",
    title: "Family Wedding Flow",
    description: "Rigorous vendor coordination and stage discipline designed so parents and the couple never feel rushed. Harmonized varmala timings, bridal entry music cues, and lavish mandap floral execution.",
    scope: "Vendors · Mandap · Audio/DJ · Hospitality"
  },
  {
    category: "Corporate Gala · Mumbai",
    title: "On-Time Office Summit",
    description: "Punctual execution for 400+ corporate guests. High-definition LED backdrop setup, multi-speaker lapel mic configuration, prompt keynote run-sheet, and professional VIP dinner handover.",
    scope: "AV Engineering · Stage · Anchoring · Logistics"
  }
];

export const GALLERY_FRAMES = [
  { title: "Sangeet & Mehendi · Mumbai", image: "gallery-sangeet.jpg" },
  { title: "Royal Wedding Aisle", image: "gallery-wedding-aisle.jpg" },
  { title: "Milestone 1st Birthday", image: "gallery-birthday.jpg" },
  { title: "Bespoke Floral Styling", image: "gallery-floral-decor.jpg" },
  { title: "Annual Corporate Gala", image: "gallery-corporate-dinner.jpg" },
  { title: "Commercial Property Expo", image: "gallery-trade-expo.jpg" }
];
