const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/authorizeRoles");

router.use(authMiddleware);

// Create a new customer
router.post(
  "/",
  authorizeRoles("admin", "manager"),
  async (req, res) => {
    const { name, email, phone, address } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Customer name is required",
      });
    }

    if (email !== undefined && email !== null && typeof email !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Email must be a valid string",
      });
    }

    if (phone !== undefined && phone !== null && typeof phone !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Phone must be a valid string",
      });
    }

    if (address !== undefined && address !== null && typeof address !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Address must be a valid string",
      });
    }

    try {
      const result = await pool.query(
        `INSERT INTO customers
          (company_id, name, email, phone, address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, company_id, name, email, phone, address, created_at`,
        [
          req.user.companyId,
          name.trim(),
          email?.trim() || null,
          phone?.trim() || null,
          address?.trim() || null,
        ]
      );

      return res.status(201).json({
        status: "success",
        message: "Customer created successfully",
        customer: result.rows[0],
      });
    } catch (error) {
      console.error("Create customer error:", error);

      return res.status(500).json({
        status: "error",
        message: "Server error while creating customer",
      });
    }
  }
);

// Get all customers belonging to the logged-in user's company
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, address, created_at, updated_at
       FROM customers
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [req.user.companyId]
    );

    return res.status(200).json({
      status: "success",
      count: result.rows.length,
      customers: result.rows,
    });
  } catch (error) {
    console.error("Get customers error:", error);

    return res.status(500).json({
      status: "error",
      message: "Server error while fetching customers",
    });
  }
});

// Get a single customer by ID
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({
      status: "error",
      message: "Invalid customer ID",
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, phone, address, created_at, updated_at
       FROM customers
       WHERE id = $1 AND company_id = $2`,
      [id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      status: "success",
      customer: result.rows[0],
    });
  } catch (error) {
    console.error("Get customer error:", error);

    return res.status(500).json({
      status: "error",
      message: "Server error while fetching customer",
    });
  }
});

// Update an existing customer
router.put(
  "/:id",
  authorizeRoles("admin", "manager"),
  async (req, res) => {
    const { id } = req.params;
    const { name, email, phone, address } = req.body;

    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      return res.status(400).json({
        status: "error",
        message: "Invalid customer ID",
      });
    }

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Customer name is required",
      });
    }

    if (email !== undefined && email !== null && typeof email !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Email must be a valid string",
      });
    }

    if (phone !== undefined && phone !== null && typeof phone !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Phone must be a valid string",
      });
    }

    if (address !== undefined && address !== null && typeof address !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Address must be a valid string",
      });
    }

    try {
      const result = await pool.query(
        `UPDATE customers
         SET name = $1,
             email = $2,
             phone = $3,
             address = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND company_id = $6
         RETURNING id, name, email, phone, address, created_at, updated_at`,
        [
          name.trim(),
          email?.trim() || null,
          phone?.trim() || null,
          address?.trim() || null,
          id,
          req.user.companyId,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: "error",
          message: "Customer not found",
        });
      }

      return res.status(200).json({
        status: "success",
        message: "Customer updated successfully",
        customer: result.rows[0],
      });
    } catch (error) {
      console.error("Update customer error:", error);

      return res.status(500).json({
        status: "error",
        message: "Server error while updating customer",
      });
    }
  }
);

// Delete a customer
router.delete("/:id", authorizeRoles("admin"), async (req, res) => {
  const { id } = req.params;

  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return res.status(400).json({
      status: "error",
      message: "Invalid customer ID",
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM customers
       WHERE id = $1 AND company_id = $2
       RETURNING id, name`,
      [id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Customer deleted successfully",
      customer: result.rows[0],
    });
  } catch (error) {
    console.error("Delete customer error:", error);

    return res.status(500).json({
      status: "error",
      message: "Server error while deleting customer",
    });
  }
});

module.exports = router;

