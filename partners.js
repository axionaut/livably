/* Revenue switches. Everything here is optional and starts empty: the site
   works the same with or without it, and a partner link is only shown once it
   would actually earn something (stays are the exception — a dated stay search
   is useful on its own, so it is always there and simply starts earning once
   an ID is filled in).

   Paste exactly what each partner's dashboard gives you. Nothing else needs
   to change; the page reads this file on load. */
window.LIVABLY_PARTNERS = {
  // Booking.com Affiliate Partner ID ("aid"). Every "Stay in <month>" link on
  // Follow the weather and on the place page carries it.
  bookingAid: "",

  // Full referral links, as copied from each programme. Leave "" to hide.
  insurance: "",   // nomad / travel medical insurance, e.g. SafetyWing
  esim: "",        // travel eSIM, e.g. Airalo
  visa: "",        // visa service, shown next to e-visa and on-arrival places

  // A tip jar for people who just like the tool (Ko-fi, Buy Me a Coffee,
  // GitHub Sponsors...). Shown in the footer only.
  support: "",

  // GoatCounter site code ("livably" for livably.goatcounter.com). Counts
  // visits and every partner click, cookie-free, so you can see what earns.
  goatcounter: "",
};
