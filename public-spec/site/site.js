(() => {
  const root = document.documentElement;
  const toggle = document.querySelector("[data-theme-toggle]");
  const label = document.querySelector("[data-theme-label]");
  const themes = ["system", "light", "dark"];
  const readTheme = () => {
    try {
      const stored = window.localStorage.getItem("threadleaf-public-spec-theme");
      return themes.includes(stored) ? stored : "system";
    } catch {
      return "system";
    }
  };
  const nextTheme = (current) => themes[(themes.indexOf(current) + 1) % themes.length];
  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    if (!toggle || !label) return;
    const next = nextTheme(theme);
    toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    label.textContent = `Use ${next} scheme`;
    toggle.title = `Switch to ${next} scheme`;
  };
  applyTheme(readTheme());
  toggle?.addEventListener("click", () => {
    const theme = nextTheme(root.dataset.theme || "system");
    applyTheme(theme);
    try {
      window.localStorage.setItem("threadleaf-public-spec-theme", theme);
    } catch {
      /* file:// may not expose storage */
    }
  });
  const filter = document.querySelector("[data-table-filter]");
  const count = document.querySelector("[data-filter-count]");
  const rows = [...document.querySelectorAll("[data-filter-table] tbody tr")];
  filter?.addEventListener("input", () => {
    const query = filter.value.trim().toLocaleLowerCase("en-US");
    let visible = 0;
    for (const row of rows) {
      const matches = !query || row.textContent.toLocaleLowerCase("en-US").includes(query);
      row.dataset.hidden = matches ? "false" : "true";
      if (matches) visible += 1;
    }
    if (count) count.textContent = query ? `${visible} matching rows` : "All rows";
  });
  const links = [...document.querySelectorAll(".section-nav a")];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          for (const link of links)
            link.toggleAttribute(
              "aria-current",
              link.getAttribute("href") === `#${entry.target.id}`,
            );
        }
      },
      { rootMargin: "-20% 0px -70%" },
    );
    sections.forEach((section) => {
      observer.observe(section);
    });
  }
})();
