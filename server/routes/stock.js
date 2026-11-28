const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/authorizeRoles");

router.use(authMiddleware);

// Add stock to a product's inventory
router.post(
  "/in",
  authorizeRoles("admin", "manager", "staff"),
  async (req, res) => {
    const { productId, quantity, reason } = req.body;

    // Validate product ID
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid product ID",
      });
    }

    // Validate stock quantity
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Quantity must be a positive integer",
      });
    }

    // Validate reason
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Reason must be a string",
      });
    }

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      // Lock the product row to prevent concurrent stock updates
      const product = await client.query(
        `SELECT id, name, quantity
         FROM products
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [productId, req.user.companyId]
      );

      if (product.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          status: "error",
          message: "Product not found",
        });
      }

      // Increase product stock
      const updatedProduct = await client.query(
        `UPDATE products
         SET quantity = quantity + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [quantity, productId, req.user.companyId]
      );

      // Record the stock movement
      const movement = await client.query(
        `INSERT INTO stock_movements
         (company_id, product_id, user_id, movement_type, quantity_change, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.user.companyId,
          productId,
          req.user.id,
          "stock_in",
          quantity,
          reason || null,
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: "success",
        message: "Stock added successfully",
        product: updatedProduct.rows[0],
        movement: movement.rows[0],
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError);
        }
      }

      console.error("Stock in error:", error);

      res.status(500).json({
        status: "error",
        message: "Failed to add stock",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// Remove stock from a product's inventory
router.post(
  "/out",
  authorizeRoles("admin", "manager", "staff"),
  async (req, res) => {
    const { productId, quantity, reason } = req.body;

    // Validate product ID
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid product ID",
      });
    }

    // Validate stock quantity
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Quantity must be a positive integer",
      });
    }

    // Validate reason
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Reason must be a string",
      });
    }

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      // Lock the product row to prevent concurrent stock updates
      const product = await client.query(
        `SELECT id, name, quantity
         FROM products
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [productId, req.user.companyId]
      );

      if (product.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          status: "error",
          message: "Product not found",
        });
      }

      // Check available stock
      if (product.rows[0].quantity < quantity) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          status: "error",
          message: "Insufficient stock available",
        });
      }

      // Decrease product stock
      const updatedProduct = await client.query(
        `UPDATE products
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [quantity, productId, req.user.companyId]
      );

      // Record the stock movement
      const movement = await client.query(
        `INSERT INTO stock_movements
         (company_id, product_id, user_id, movement_type, quantity_change, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.user.companyId,
          productId,
          req.user.id,
          "stock_out",
          -quantity,
          reason || null,
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: "success",
        message: "Stock removed successfully",
        product: updatedProduct.rows[0],
        movement: movement.rows[0],
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError);
        }
      }

      console.error("Stock out error:", error);

      res.status(500).json({
        status: "error",
        message: "Failed to remove stock",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// Adjust a product's inventory to the actual physical quantity
router.post(
  "/adjustment",
  authorizeRoles("admin", "manager"),
  async (req, res) => {
    const { productId, newQuantity, reason } = req.body;

    // Validate product ID
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid product ID",
      });
    }

    // Validate new quantity
    if (
      !Number.isSafeInteger(newQuantity) ||
      newQuantity < 0
    ) {
      return res.status(400).json({
        status: "error",
        message: "New quantity must be a non-negative integer",
      });
    }

    // Validate reason
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Reason must be a string",
      });
    }

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      // Lock the product row to prevent concurrent stock updates
      const product = await client.query(
        `SELECT id, name, quantity
         FROM products
         WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
        [productId, req.user.companyId]
      );

      if (product.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          status: "error",
          message: "Product not found",
        });
      }

      // Calculate the quantity difference
      const quantityChange =
        newQuantity - product.rows[0].quantity;

      if (quantityChange === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          status: "error",
          message: "New quantity is the same as current stock",
        });
      }

      // Update product quantity
      const updatedProduct = await client.query(
        `UPDATE products
         SET quantity = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [newQuantity, productId, req.user.companyId]
      );

      // Record the stock adjustment
      const movement = await client.query(
        `INSERT INTO stock_movements
         (company_id, product_id, user_id, movement_type, quantity_change, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.user.companyId,
          productId,
          req.user.id,
          "adjustment",
          quantityChange,
          reason || null,
        ]
      );

      await client.query("COMMIT");

      res.status(200).json({
        status: "success",
        message: "Stock adjusted successfully",
        product: updatedProduct.rows[0],
        movement: movement.rows[0],
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback error:", rollbackError);
        }
      }

      console.error("Stock adjustment error:", error);

      res.status(500).json({
        status: "error",
        message: "Failed to adjust stock",
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// Get stock movement history
router.get("/movements", async (req, res) => {
  try {
    const movements = await pool.query(
      `SELECT
         sm.id,
         sm.product_id,
         p.name AS product_name,
         p.sku,
         sm.user_id,
         u.name AS user_name,
         sm.movement_type,
         sm.quantity_change,
         sm.reason,
         sm.created_at
       FROM stock_movements sm
       JOIN products p ON sm.product_id = p.id
       LEFT JOIN users u ON sm.user_id = u.id
       WHERE sm.company_id = $1
       ORDER BY sm.created_at DESC`,
      [req.user.companyId]
    );

    res.status(200).json({
      status: "success",
      count: movements.rows.length,
      movements: movements.rows,
    });
  } catch (error) {
    console.error("Stock movement history error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to retrieve stock movement history",
    });
  }
});

// Get low stock products
router.get("/low-stock", async (req, res) => {
  try {
    const products = await pool.query(
      `SELECT
         id,
         name,
         sku,
         quantity,
         low_stock_threshold,
         price
       FROM products
       WHERE company_id = $1
         AND quantity <= low_stock_threshold
       ORDER BY quantity ASC`,
      [req.user.companyId]
    );

    res.status(200).json({
      status: "success",
      count: products.rows.length,
      products: products.rows,
    });
  } catch (error) {
    console.error("Low stock alert error:", error);

    res.status(500).json({
      status: "error",
      message: "Failed to retrieve low stock products",
    });
  }
});

module.exports = router;