const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/authorizeRoles");

router.use(authMiddleware);

router.post("/", authorizeRoles("admin", "manager"), async (req, res) => {
  const {
    name,
    sku,
    description,
    price,
    lowStockThreshold = 10,
    categoryId = null,
  } = req.body;

  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof sku !== "string" ||
    !sku.trim() ||
    price === undefined ||
    price === null ||
    price === ""
  ) {
    return res.status(400).json({
      status: "error",
      message: "Name, SKU, and price are required",
    });
  }

  if (!Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({
      status: "error",
      message: "Price must be a valid non-negative number",
    });
  }

  if (
    !Number.isInteger(Number(lowStockThreshold)) ||
    Number(lowStockThreshold) < 0
  ) {
    return res.status(400).json({
      status: "error",
      message: "Low stock threshold must be a non-negative integer",
    });
  }

  // Validate description
  if (description !== undefined && description !== null && typeof description !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Description must be a string",
    });
  }


   // Validate category ID
  if (
    categoryId !== null &&
    (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0)
  ) {
    return res.status(400).json({
      status: "error",
      message: "Invalid category ID",
    });
  }

  try {
    if (categoryId !== null) {
      const category = await pool.query(
        "SELECT id FROM categories WHERE id = $1 AND company_id = $2",
        [categoryId, req.user.companyId]
      );

      if (category.rows.length === 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid category",
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO products
       (company_id, category_id, name, sku, description, price, quantity, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.user.companyId,
        categoryId,
        name.trim(),
        sku.trim(),
        description || null,
        Number(price),
        0,
        Number(lowStockThreshold),
      ]
    );

    res.status(201).json({
      status: "success",
      message: "Product created successfully",
      product: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        status: "error",
        message: "A product with this SKU already exists",
      });
    }

    console.error("Product creation error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to create product",
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         products.*,
         categories.name AS category_name
       FROM products
       LEFT JOIN categories
         ON products.category_id = categories.id
       WHERE products.company_id = $1
       ORDER BY products.created_at DESC`,
      [req.user.companyId]
    );

    res.status(200).json({
      status: "success",
      count: result.rows.length,
      products: result.rows,
    });
  } catch (error) {
    console.error("Get products error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to retrieve products",
    });
  }
});

// Get a single product belonging to the authenticated user's company
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Invalid product ID",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         products.*,
         categories.name AS category_name
       FROM products
       LEFT JOIN categories
         ON products.category_id = categories.id
       WHERE products.id = $1 AND products.company_id = $2`,
      [id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Product not found",
      });
    }

    res.status(200).json({
      status: "success",
      product: result.rows[0],
    });
  } catch (error) {
    console.error("Get product error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to retrieve product",
    });
  }
});

// Update a product belonging to the authenticated user's company
router.put("/:id", authorizeRoles("admin", "manager"), async (req, res) => {
  const { id } = req.params;
  const {
    name,
    sku,
    description,
    price,
    lowStockThreshold,
    categoryId,
  } = req.body;

  // Validate product ID
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Invalid product ID",
    });
  }

  // Validate required fields
  if (
    !name ||
    !sku ||
    price === undefined ||
    price === null ||
    price === "" ||
    lowStockThreshold === undefined ||
    categoryId === undefined
  ) {
    return res.status(400).json({
      status: "error",
      message: "Name, SKU, price, low stock threshold, and category ID are required",
    });
  }

  // Validate price
  if (!Number.isFinite(Number(price)) || Number(price) < 0) {
    return res.status(400).json({
      status: "error",
      message: "Price must be a valid non-negative number",
    });
  }

  // Validate category ID
  if (
     categoryId !== null &&
     (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0)
  ) {
    return res.status(400).json({
      status: "error",
      message: "Invalid category ID",
    });
  }



  // Validate low stock threshold
  if (
    !Number.isInteger(Number(lowStockThreshold)) ||
    Number(lowStockThreshold) < 0
  ) {
    return res.status(400).json({
      status: "error",
      message: "Low stock threshold must be a non-negative integer",
    });
  }

  // Validate product name and SKU
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof sku !== "string" ||
    !sku.trim()
  ) {
    return res.status(400).json({
      status: "error",
      message: "Product name and SKU must be non-empty strings",
    });
  }

  // Validate description
  if (description !== undefined && description !== null && typeof description !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Description must be a string",
     });
  }

  try {
    // Verify product ownership
    const existingProduct = await pool.query(
      "SELECT id FROM products WHERE id = $1 AND company_id = $2",
      [id, req.user.companyId]
    );

    if (existingProduct.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Product not found",
      });
    }

    // Validate category ownership
    if (categoryId !== undefined && categoryId !== null) {
      const category = await pool.query(
        "SELECT id FROM categories WHERE id = $1 AND company_id = $2",
        [categoryId, req.user.companyId]
      );

      if (category.rows.length === 0) {
        return res.status(400).json({
          status: "error",
          message: "Invalid category",
        });
      }
    }

    const result = await pool.query(
      `UPDATE products
       SET category_id = $1,
           name = $2,
           sku = $3,
           description = $4,
           price = $5,
           low_stock_threshold = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND company_id = $8
       RETURNING *`,
      [
        categoryId === undefined ? null : categoryId,
        name.trim(),
        sku.trim(),
        description || null,
        Number(price),
        Number(lowStockThreshold),
        id,
        req.user.companyId,
      ]
    );

    res.status(200).json({
      status: "success",
      message: "Product updated successfully",
      product: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        status: "error",
        message: "A product with this SKU already exists",
      });
    }

    console.error("Product update error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to update product",
    });
  }
});

// Delete a product belonging to the authenticated user's company
router.delete("/:id", authorizeRoles("admin"), async (req, res) => {
  const { id } = req.params;

  // Validate product ID
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
    return res.status(400).json({
      status: "error",
      message: "Invalid product ID",
    });
  }
  try {
    // Ensure the product belongs to the authenticated user's company
    const result = await pool.query(
      `DELETE FROM products
       WHERE id = $1 AND company_id = $2
       RETURNING id`,
      [id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Product not found",
      });
    }

    res.status(200).json({
      status: "success",
      message: "Product deleted successfully",
    });
  } catch (error) {
    // Prevent deletion of products referenced by stock movements or orders
    if (error.code === "23503") {
      return res.status(409).json({
        status: "error",
        message: "Cannot delete a product linked to stock movements or orders",
      });
    }

    console.error("Product deletion error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to delete product",
    });
  }
});

module.exports = router;

