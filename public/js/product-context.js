import { createApiClient } from "./api.js";
import { renderWebModuleNavigation } from "./module-navigation.js";

// The same Web assets can be served by the suite or either product host.
// Standalone navigation must only advertise routes that host actually owns.
try {
  const { product, modules } = await createApiClient()("/api/modules");
  if (product && product.id !== "suite") {
    document.body.dataset.product = product.id;
    const brand = document.querySelector(".product-brand");
    if (brand) { brand.href = product.home; brand.setAttribute("aria-label", `返回${product.title}`); }
    const title = document.querySelector(".product-brand-text strong");
    if (title) title.textContent = product.title;
    for (const link of document.querySelectorAll('.product-actions a[href="/android-update"]')) link.hidden = true;
    if (product.id === "short-videos") {
      const links = renderWebModuleNavigation(document.querySelector(".product-nav"), modules || []);
      for (const link of links) { link.classList.add("active"); link.setAttribute("aria-current", "page"); }
      const admin = document.getElementById("topAdminLink"); if (admin) admin.hidden = true;
    }
  }
} catch (error) { console.warn("[product-context]", error.message); }
