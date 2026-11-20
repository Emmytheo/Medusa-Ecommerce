export default async function extendProductFields(): Promise<void> {
  try {
    const storeProductsImports = require("@medusajs/medusa/dist/api/routes/store/products/index");
    if (Array.isArray(storeProductsImports.defaultStoreProductsFields)) {
      if (!storeProductsImports.defaultStoreProductsFields.includes("store_id")) {
        storeProductsImports.defaultStoreProductsFields.push("store_id");
      }
    }
    if (Array.isArray(storeProductsImports.allowedStoreProductsFields)) {
      if (!storeProductsImports.allowedStoreProductsFields.includes("store_id")) {
        storeProductsImports.allowedStoreProductsFields.push("store_id");
      }
    }
    if (Array.isArray(storeProductsImports.allowedStoreProductsRelations)) {
      if (!storeProductsImports.allowedStoreProductsRelations.includes("store")) {
        storeProductsImports.allowedStoreProductsRelations.push("store");
      }
    }
  } catch (err) {
    console.warn("[extendProductFields] Store product fields patch warning:", err);
  }

  try {
    const adminProductsImports = require("@medusajs/medusa/dist/api/routes/admin/products/index");
    if (Array.isArray(adminProductsImports.defaultAdminProductFields)) {
      if (!adminProductsImports.defaultAdminProductFields.includes("store_id")) {
        adminProductsImports.defaultAdminProductFields.push("store_id");
      }
    }
    if (Array.isArray(adminProductsImports.allowedAdminProductFields)) {
      if (!adminProductsImports.allowedAdminProductFields.includes("store_id")) {
        adminProductsImports.allowedAdminProductFields.push("store_id");
      }
    }
  } catch (err) {
    console.warn("[extendProductFields] Admin product fields patch warning:", err);
  }
}
