-- ============================================================================
-- Rabbit Alley POS - Single Schema (run this file only)
-- ============================================================================
-- One-time setup: creates database, all tables, roles, permissions, seed data.
-- Run this single file in HeidiSQL (or mysql client) for a complete setup.
--
-- Default Accounts (see bottom of file): MGR001, WTR001, BAR001 / password
-- ============================================================================

-- Create and use database
CREATE DATABASE IF NOT EXISTS rabbit_alley_pos
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE rabbit_alley_pos;

-- ============================================================================
-- SCHEMA: Tables
-- ============================================================================

-- Roles (guard: web for web app)
CREATE TABLE IF NOT EXISTS roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  guard VARCHAR(32) NOT NULL DEFAULT 'web',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_roles_name_guard (name, guard)
);

-- Permissions (all permission names used by the app)
CREATE TABLE IF NOT EXISTS permissions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_permissions_name (name)
);

-- Role-Permission mapping
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Branches (multi-branch support)
CREATE TABLE IF NOT EXISTS branches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  code VARCHAR(32) NOT NULL,
  address VARCHAR(255) DEFAULT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_branches_code (code)
);

-- Users (staff with login: employee_id, email, password; branch_id = which branch they work at)
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  email VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  nickname VARCHAR(64) DEFAULT NULL,
  allowance DECIMAL(10,2) NOT NULL DEFAULT 0,
  hourly DECIMAL(10,2) NOT NULL DEFAULT 0,
  -- New fields for commission/incentive system
  budget DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 0,  -- % commission on ladies drinks
  incentive_rate DECIMAL(10,2) NOT NULL DEFAULT 0,  -- Fixed amount per ladies drink
  table_incentive DECIMAL(10,2) NOT NULL DEFAULT 0, -- Incentive per table served
  has_quota TINYINT(1) NOT NULL DEFAULT 0,          -- 1 = has quota, 0 = no quota
  quota_amount DECIMAL(10,2) NOT NULL DEFAULT 0,    -- Quota target amount
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_users_employee_id (employee_id),
  UNIQUE KEY uk_users_email (email),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

-- POS tables (per branch; areas: Lounge, Club, LD). PK (branch_id, id) = same table code per branch.
CREATE TABLE IF NOT EXISTS pos_tables (
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  id VARCHAR(16) NOT NULL,
  name VARCHAR(32) NOT NULL,
  area ENUM('Lounge','Club','LD') NOT NULL,
  status ENUM('available','occupied') NOT NULL DEFAULT 'available',
  current_order_id VARCHAR(32) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (branch_id, id),
  KEY idx_pos_tables_branch (branch_id),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

-- Waiter table assignments: manager assigns specific tables to specific waiters.
-- If a waiter has no rows here they see an "Ask Your Manager" message on the POS.
CREATE TABLE IF NOT EXISTS waiter_table_assignments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  user_id INT UNSIGNED NOT NULL,
  table_id VARCHAR(16) NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_waiter_table (branch_id, user_id, table_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_id, table_id) REFERENCES pos_tables(branch_id, id) ON DELETE CASCADE
);

-- Products (with optimized indexes for fast lookups)
-- sub_category: optional (e.g. "1pc", "2pc", "Gravy") for fastfood-style options under a category
CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(512) DEFAULT NULL,
  category VARCHAR(64) NOT NULL,
  sub_category VARCHAR(64) DEFAULT NULL,
  department VARCHAR(32) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission DECIMAL(10,2) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_products_sku (sku),
  KEY idx_products_category (category),
  KEY idx_products_sub_category (sub_category),
  KEY idx_products_department (department),
  KEY idx_products_status (status),
  KEY idx_products_name (name(50))
);

-- Orders (for dashboard stats and reports; branch_id scopes to branch)
-- Daily sequence per branch for display order numbers (YYYYMMDD-0001)
CREATE TABLE IF NOT EXISTS order_number_sequences (
  branch_id INT UNSIGNED NOT NULL,
  seq_date DATE NOT NULL,
  last_seq INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, seq_date)
);

-- Table sessions: one continuous customer occupancy of a physical table
CREATE TABLE IF NOT EXISTS table_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  table_id VARCHAR(16) NOT NULL,
  waiter_id VARCHAR(32) DEFAULT NULL COMMENT 'employee_id of waiter at open',
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_by VARCHAR(128) DEFAULT NULL,
  migrated_legacy TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = best-effort backfill from pre-session data',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_table_sessions_branch_table (branch_id, table_id, status),
  KEY idx_table_sessions_opened (branch_id, opened_at),
  KEY idx_table_sessions_closed (branch_id, closed_at),
  KEY idx_table_sessions_waiter (branch_id, waiter_id),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  order_number VARCHAR(32) DEFAULT NULL,
  table_id VARCHAR(16) DEFAULT NULL,
  table_visit_id INT UNSIGNED DEFAULT NULL,
  session_id BIGINT UNSIGNED DEFAULT NULL,
  status ENUM('pending','paid','voided','cancelled') NOT NULL DEFAULT 'pending',
  payment_method VARCHAR(32) DEFAULT NULL,  -- cash, gcash, debit, credit, bank
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  service_charge DECIMAL(12,2) NOT NULL DEFAULT 0,
  card_surcharge DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  employee_id VARCHAR(32) DEFAULT NULL,
  order_date DATE NOT NULL,
  voided_at TIMESTAMP NULL DEFAULT NULL,
  voided_by INT UNSIGNED DEFAULT NULL,
  voided_by_name VARCHAR(128) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_branch_number (branch_id, order_number),
  KEY idx_orders_branch (branch_id),
  KEY idx_orders_date (order_date),
  KEY idx_orders_status (status),
  KEY idx_orders_table (table_id),
  KEY idx_orders_table_visit (branch_id, table_id, table_visit_id),
  KEY idx_orders_session (session_id),
  KEY idx_orders_employee (employee_id),
  KEY idx_orders_date_status (order_date, status),
  KEY idx_orders_payment_method (payment_method),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

-- Order Items (items in each order)
-- product_sku: inventory identity snapshot (same SKU across all price variants)
-- product_price_id: which price variant was charged (does not affect stock identity)
-- special_request: guest note (e.g. no onions). is_voided/voided_by/voided_at/voided_by_name for per-item void.
CREATE TABLE IF NOT EXISTS order_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED DEFAULT NULL,
  product_sku VARCHAR(64) DEFAULT NULL,
  product_price_id INT UNSIGNED DEFAULT NULL,
  product_name VARCHAR(128) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  department VARCHAR(32) NOT NULL DEFAULT 'Bar',
  sent_to_dept TINYINT(1) NOT NULL DEFAULT 0,
  is_complimentary TINYINT(1) NOT NULL DEFAULT 0,  -- 1 = complimentary/free item
  served_by INT UNSIGNED DEFAULT NULL,             -- Staff who served this (for commission)
  special_request VARCHAR(512) DEFAULT NULL,        -- Guest note per item
  is_voided TINYINT(1) NOT NULL DEFAULT 0,
  voided_by INT UNSIGNED DEFAULT NULL,
  voided_at TIMESTAMP NULL DEFAULT NULL,
  voided_by_name VARCHAR(128) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  KEY idx_order_items_order (order_id)
);

-- Discounts (type: Standalone/Applied; category: Seasonal, VIP, Senior, PWD, Happy Hour, Promo)
CREATE TABLE IF NOT EXISTS discounts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type ENUM('Standalone','Applied') NOT NULL,
  category VARCHAR(32) DEFAULT NULL,
  applicable_to ENUM('Order','Product','Item','Category') NOT NULL DEFAULT 'Order',
  value VARCHAR(32) NOT NULL,
  valid_from DATE DEFAULT NULL,
  valid_to DATE DEFAULT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  creator_id INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_discounts_status (status),
  KEY idx_discounts_category (category)
);

-- Payouts (payroll report)
CREATE TABLE IF NOT EXISTS payouts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  allowance DECIMAL(10,2) NOT NULL DEFAULT 0,
  hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  commission DECIMAL(10,2) NOT NULL DEFAULT 0,
  incentives DECIMAL(10,2) NOT NULL DEFAULT 0,
  adjustments DECIMAL(10,2) NOT NULL DEFAULT 0,
  deductions DECIMAL(10,2) NOT NULL DEFAULT 0,
  incentives_breakdown JSON DEFAULT NULL,
  adjustments_breakdown JSON DEFAULT NULL,
  deductions_breakdown JSON DEFAULT NULL,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  status ENUM('draft','approved') NOT NULL DEFAULT 'draft',
  approved_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_payouts_period (period_from, period_to),
  UNIQUE KEY uk_payouts_user_period (user_id, period_from, period_to)
);

-- ============================================================================
-- SHIFT MANAGEMENT TABLES
-- ============================================================================

-- Shifts (cashier shift tracking; branch_id scopes to branch)
CREATE TABLE IF NOT EXISTS shifts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  shift_date DATE NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME DEFAULT NULL,
  status ENUM('open','closed','approved') NOT NULL DEFAULT 'open',
  opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- Calculated totals during shift
  total_cash_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_card_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_gcash_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_bank_sales DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_refunds DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_voids DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- Cash count at close
  expected_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  actual_cash DECIMAL(12,2) DEFAULT NULL,
  cash_variance DECIMAL(12,2) DEFAULT NULL,
  variance_reason VARCHAR(512) DEFAULT NULL,
  -- Approval
  approved_by INT UNSIGNED DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
  KEY idx_shifts_branch (branch_id),
  KEY idx_shifts_user_date (user_id, shift_date),
  KEY idx_shifts_status (status)
);

-- Cash Count Details (denomination breakdown)
CREATE TABLE IF NOT EXISTS cash_counts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  shift_id INT UNSIGNED NOT NULL,
  denomination VARCHAR(32) NOT NULL,  -- e.g., '1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.25'
  quantity INT NOT NULL DEFAULT 0,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
);

-- ============================================================================
-- PAYMENT MANAGEMENT TABLES
-- ============================================================================

-- Refunds (track all refunds)
CREATE TABLE IF NOT EXISTS refunds (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  original_payment_method VARCHAR(32) NOT NULL,
  refund_amount DECIMAL(12,2) NOT NULL,
  refund_method VARCHAR(32) NOT NULL,  -- cash, original_method, store_credit
  reason VARCHAR(512) NOT NULL,
  status ENUM('pending','approved','completed','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT UNSIGNED NOT NULL,
  approved_by INT UNSIGNED DEFAULT NULL,
  shift_id INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
  KEY idx_refunds_order (order_id),
  KEY idx_refunds_status (status)
);

-- Void audit log (one row per voided line — immutable snapshots for Void Report)
CREATE TABLE IF NOT EXISTS void_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  void_type ENUM('item','order','payment') NOT NULL DEFAULT 'item',
  order_id INT UNSIGNED DEFAULT NULL,
  order_item_id INT UNSIGNED DEFAULT NULL,
  product_id INT UNSIGNED DEFAULT NULL,
  product_sku VARCHAR(64) DEFAULT NULL,
  product_name VARCHAR(128) NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  table_id VARCHAR(16) DEFAULT NULL,
  session_id BIGINT UNSIGNED DEFAULT NULL,
  voided_by INT UNSIGNED DEFAULT NULL,
  voided_by_name VARCHAR(128) DEFAULT NULL,
  voided_by_employee_id VARCHAR(32) DEFAULT NULL,
  voided_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason VARCHAR(512) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_void_log_branch_time (branch_id, voided_at),
  KEY idx_void_log_voided_by (branch_id, voided_by),
  KEY idx_void_log_table (branch_id, table_id),
  KEY idx_void_log_product (product_sku),
  KEY idx_void_log_order (order_id)
);

-- Payment Voids (voided/cancelled payments)
CREATE TABLE IF NOT EXISTS payment_voids (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  payment_method VARCHAR(32) NOT NULL,
  voided_amount DECIMAL(12,2) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  status ENUM('pending','approved','completed','rejected') NOT NULL DEFAULT 'pending',
  requested_by INT UNSIGNED NOT NULL,
  approved_by INT UNSIGNED DEFAULT NULL,
  shift_id INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL,
  KEY idx_voids_order (order_id),
  KEY idx_voids_status (status)
);

-- Split Payments (for split bill tracking)
CREATE TABLE IF NOT EXISTS split_payments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  split_number INT NOT NULL,  -- 1, 2, 3... for each split
  amount DECIMAL(12,2) NOT NULL,
  payment_method VARCHAR(32) NOT NULL,
  status ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  paid_at DATETIME DEFAULT NULL,
  processed_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_split_order (order_id)
);

-- Payment Conversions (track digital->cash conversions, e.g. pasahod)
CREATE TABLE IF NOT EXISTS payment_conversions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  shift_id INT UNSIGNED DEFAULT NULL,
  from_method VARCHAR(32) NOT NULL COMMENT 'gcash, maya, bank, bpi, debit, credit, online',
  to_method VARCHAR(32) NOT NULL DEFAULT 'cash',
  amount DECIMAL(12,2) NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  converted_by VARCHAR(64) DEFAULT NULL,
  converted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_conversions_branch (branch_id),
  KEY idx_conversions_shift (shift_id),
  KEY idx_conversions_date (converted_at),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL
);

-- Charge/Utang (credit) transactions - track who owes and payment status
CREATE TABLE IF NOT EXISTS charge_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  order_ids TEXT DEFAULT NULL,
  customer_name VARCHAR(128) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  collection_method VARCHAR(32) DEFAULT NULL,  -- cash/gcash/bank/card when utang is collected
  shift_id INT UNSIGNED DEFAULT NULL,          -- shift during which collection was recorded
  charged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL,
  charged_by VARCHAR(64) DEFAULT NULL,
  paid_by VARCHAR(64) DEFAULT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  KEY idx_charges_branch (branch_id),
  KEY idx_charges_customer (customer_name(64)),
  KEY idx_charges_status (status),
  KEY idx_charges_date (charged_at),
  KEY idx_charges_paid_at (paid_at),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

-- Table Transfers (track order movements between tables)
CREATE TABLE IF NOT EXISTS table_transfers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  from_table VARCHAR(16) NOT NULL,
  to_table VARCHAR(16) NOT NULL,
  transfer_type ENUM('move','merge','split') NOT NULL DEFAULT 'move',
  transferred_by INT UNSIGNED NOT NULL,
  reason VARCHAR(256) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (transferred_by) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_transfer_order (order_id)
);

-- ============================================================================
-- ATTENDANCE (time-in/time-out for payroll hours)
-- ============================================================================

CREATE TABLE IF NOT EXISTS attendance (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  work_date DATE NOT NULL,
  time_in DATETIME NOT NULL,
  time_out DATETIME DEFAULT NULL,
  break_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_attendance_user_date (user_id, work_date),
  KEY idx_attendance_date (work_date),
  KEY idx_attendance_user_date (user_id, work_date)
);

-- ============================================================================
-- AUDIT LOGS (track all employee actions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED DEFAULT NULL,
  employee_id VARCHAR(32) DEFAULT NULL,
  user_name VARCHAR(128) DEFAULT NULL,
  role_name VARCHAR(64) DEFAULT NULL,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) DEFAULT NULL,
  entity_id VARCHAR(64) DEFAULT NULL,
  details JSON DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  branch_id INT UNSIGNED DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id),
  KEY idx_audit_employee (employee_id),
  KEY idx_audit_action (action),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_branch (branch_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

-- ============================================================================
-- SETTINGS (business and POS configuration)
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(64) NOT NULL,
  setting_value TEXT,
  category VARCHAR(32) DEFAULT 'general',
  description VARCHAR(255) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_settings_key (setting_key)
);

-- Immutable print snapshots for faithful historical reprint
CREATE TABLE IF NOT EXISTS receipt_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_id INT UNSIGNED NOT NULL DEFAULT 1,
  snapshot_type ENUM('official_receipt','running_bill') NOT NULL,
  order_id INT UNSIGNED DEFAULT NULL,
  table_id VARCHAR(16) DEFAULT NULL,
  table_visit_id INT UNSIGNED DEFAULT NULL,
  session_id BIGINT UNSIGNED DEFAULT NULL,
  payment_method VARCHAR(32) DEFAULT NULL,
  receipt_json JSON NOT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_receipt_snapshots_order (branch_id, order_id, snapshot_type, created_at),
  KEY idx_receipt_snapshots_table (branch_id, table_id, snapshot_type, created_at),
  KEY idx_receipt_snapshots_visit (branch_id, table_visit_id, snapshot_type, created_at),
  KEY idx_receipt_snapshots_session (branch_id, session_id),
  KEY idx_receipt_snapshots_created (created_at),
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT
);

INSERT INTO settings (setting_key, setting_value, category, description) VALUES
('business_name', 'Rabbit Alley', 'business', 'Business name'),
('business_address', '123 Main Street, Manila, Philippines', 'business', 'Business address'),
('business_contact', '+63 912 345 6789', 'business', 'Contact number'),
('vat_tin', '123-456-789-000', 'business', 'VAT TIN number'),
('receipt_footer', 'Thank you for visiting Rabbit Alley!', 'receipt', 'Receipt footer message'),
('tax_rate', '12', 'tax', 'Tax rate percentage (VAT)'),
('service_charge_mode', 'percent', 'charges', 'Service charge mode: percent or fixed'),
('service_charge_value', '10', 'charges', 'Service charge value'),
('card_surcharge', '2', 'charges', 'Card surcharge percentage')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

-- Printer per print job type (do not overwrite existing Manager assignments on re-seed)
INSERT IGNORE INTO settings (setting_key, setting_value, category, description) VALUES
('printer_assignments', '{"payment_receipt":"","running_bill":"","order_slip":"","bar_chit":"","kitchen_chit":"","ld_chit":""}', 'printing', 'Printer per print job type (JSON)');

-- ============================================================================
-- PRINTERS (network/USB printers added in the system — optional, .env also supported)
-- ============================================================================
CREATE TABLE IF NOT EXISTS printers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL COMMENT 'Display name (e.g. Receipt Counter 1)',
  interface VARCHAR(255) NOT NULL COMMENT 'tcp://IP:9100 or printer:WindowsPrinterName',
  type VARCHAR(32) NOT NULL DEFAULT 'epson' COMMENT 'epson, star, brother, etc.',
  branch_id INT UNSIGNED DEFAULT 1,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_printers_branch (branch_id),
  KEY idx_printers_active (active)
);

-- ============================================================================
-- PRODUCT PRICES (multiple price entries per SKU/product — inventory identity stays on products.sku)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_prices (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id INT UNSIGNED NOT NULL,
  label VARCHAR(64) NOT NULL DEFAULT 'Regular',
  area VARCHAR(20) DEFAULT NULL COMMENT 'Optional Lounge|Club|LD auto-match',
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  effective_from DATE DEFAULT NULL,
  effective_to DATE DEFAULT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_product_prices_product (product_id),
  KEY idx_product_prices_area (product_id, area),
  CONSTRAINT fk_product_prices_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- One stock bucket per product/SKU (price variant does not create separate inventory)
CREATE TABLE IF NOT EXISTS product_stock (
  product_id INT UNSIGNED NOT NULL PRIMARY KEY,
  qty_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_stock_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- ============================================================================
-- PRODUCT AREA PRICES (legacy Lounge/Club/LD — kept in sync from product_prices)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_area_prices (
  product_id INT UNSIGNED NOT NULL,
  area VARCHAR(20) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, area),
  CONSTRAINT fk_product_area_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_area CHECK (area IN ('Lounge','Club','LD'))
);

-- ============================================================================
-- MIGRATION: Add sub_category to products (run once if upgrading)
-- ============================================================================
-- Uncomment and run if your products table does not have sub_category yet:
-- ALTER TABLE products ADD COLUMN sub_category VARCHAR(64) DEFAULT NULL AFTER category;
-- ALTER TABLE products ADD KEY idx_products_sub_category (sub_category);

-- ============================================================================
-- MIGRATION: Order void + per-item void + special_request (run once if upgrading)
-- ============================================================================
-- Orders: ALTER TABLE orders ADD COLUMN voided_at TIMESTAMP NULL DEFAULT NULL AFTER order_date, ADD COLUMN voided_by INT UNSIGNED DEFAULT NULL, ADD COLUMN voided_by_name VARCHAR(128) DEFAULT NULL;
-- Table visit (legacy soft session): ALTER TABLE orders ADD COLUMN table_visit_id INT UNSIGNED DEFAULT NULL AFTER table_id, ADD KEY idx_orders_table_visit (branch_id, table_id, table_visit_id);
-- Table sessions: CREATE TABLE table_sessions (...); ALTER TABLE orders ADD COLUMN session_id BIGINT UNSIGNED DEFAULT NULL, ADD KEY idx_orders_session (session_id);
-- Order items: ALTER TABLE order_items ADD COLUMN special_request VARCHAR(512) DEFAULT NULL AFTER served_by, ADD COLUMN is_voided TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN voided_by INT UNSIGNED DEFAULT NULL, ADD COLUMN voided_at TIMESTAMP NULL DEFAULT NULL, ADD COLUMN voided_by_name VARCHAR(128) DEFAULT NULL;

-- ============================================================================
-- MIGRATIONS TRACKING (legacy - single schema run)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  migration_name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_migration_name (migration_name)
);

-- ============================================================================
-- SEED DATA: Roles
-- ============================================================================

INSERT INTO roles (id, name, guard) VALUES
(1, 'Administrator', 'web'),
(2, 'Staff', 'web'),
(3, 'Operations Staff', 'web')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============================================================================
-- SEED DATA: Permissions
-- ============================================================================

INSERT INTO permissions (id, name, description) VALUES
(1, 'view_dashboard', 'View dashboard and table map'),
(2, 'manage_products', 'Create, edit, delete products'),
(3, 'view_products', 'View product list and details'),
(4, 'manage_staff', 'Create, edit, delete staff; create login'),
(5, 'view_staff', 'View staff list and details'),
(6, 'edit_orders_after_send', 'Edit order after sent to departments'),
(7, 'view_orders', 'View orders and order details'),
(8, 'accept_payments', 'Process payments'),
(9, 'view_payments', 'View payment history'),
(10, 'print_receipts', 'Print customer receipts'),
(11, 'request_voids', 'Request void of item/order'),
(12, 'approve_voids', 'Approve or reject void requests'),
(13, 'view_voids', 'View void requests and history'),
(14, 'request_discounts', 'Create standalone or applied discounts'),
(15, 'approve_discounts', 'Approve or reject discount requests'),
(16, 'view_discounts', 'View all discounts'),
(17, 'manage_commission_rules', 'Create/edit commission rules'),
(18, 'view_commission_rules', 'View commission rules'),
(19, 'assign_ld_sales_to_staff', 'Assign LD sales to staff'),
(20, 'view_own_sales', 'View own sales for commission'),
(21, 'manage_payroll', 'Manage payroll configuration'),
(22, 'view_payroll', 'View payroll report and payouts'),
(23, 'compute_daily_payouts', 'Run daily payout computation'),
(24, 'adjust_payouts', 'Edit draft payouts; approve payouts'),
(25, 'view_reports', 'View Sales and Payroll reports'),
(26, 'export_reports', 'Export reports (PDF, Excel, CSV)'),
(27, 'view_bar_queue', 'View bar queue'),
(28, 'view_kitchen_queue', 'View kitchen queue'),
(29, 'mark_bar_items_done', 'Mark bar items as done'),
(30, 'mark_kitchen_items_done', 'Mark kitchen items as done'),
(31, 'reprint_bar_ticket', 'Reprint bar ticket'),
(32, 'reprint_kitchen_ticket', 'Reprint kitchen ticket'),
(33, 'manage_ld_staff', 'Manage LD staff'),
(34, 'view_ld_sales', 'View LD sales'),
(35, 'adjust_ld_credit_with_audit', 'Adjust LD credit with audit trail'),
(36, 'finalize_end_of_day', 'Finalize end of day'),
(37, 'view_audit_logs', 'View audit logs'),
(38, 'manage_settings', 'Update business settings'),
(39, 'manage_pos', 'Access POS (view orders, process payments)'),
(40, 'create_orders', 'Create new orders and add items at POS'),
(41, 'edit_orders_before_send', 'Edit/remove items on draft orders'),
(42, 'send_to_departments', 'Send orders to Kitchen/Bar/LD'),
-- Shift Management Permissions
(43, 'close_shift', 'Close cashier shift and submit cash count'),
(44, 'view_shift_summary', 'View shift summary and X reading'),
(45, 'approve_cash_discrepancy', 'Approve cash discrepancy explanations'),
(46, 'print_shift_report', 'Print X/Z shift reports'),
-- Payment Management Permissions
(47, 'refund_payments', 'Process refunds to customers'),
(48, 'void_payments', 'Void/cancel payments'),
(49, 'split_bill', 'Split bill across multiple payments'),
(50, 'transfer_table_orders', 'Transfer orders between tables / merge tables'),
(51, 'access_attendance', 'View and manage attendance (time-in/time-out)')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- ============================================================================
-- SEED DATA: Role Permissions
-- ============================================================================

-- Administrator (role_id=1) gets all permissions EXCEPT: floor ops (40,41,42), shifts (43-46), attendance (51)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 1, id FROM permissions WHERE id NOT IN (40, 41, 42, 43, 44, 45, 46, 51);

-- Staff (role_id=2) permissions - Floor staff, add items, send to departments (no discounts - Manager only)
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
(2, 1),  -- view_dashboard
(2, 3),  -- view_products
(2, 5),  -- view_staff
(2, 7),  -- view_orders
(2, 11), -- request_voids
(2, 13), -- view_voids
(2, 19), -- assign_ld_sales_to_staff
(2, 20), -- view_own_sales
(2, 27), -- view_bar_queue
(2, 28), -- view_kitchen_queue
(2, 39), -- manage_pos
(2, 40), -- create_orders
(2, 41), -- edit_orders_before_send
(2, 42), -- send_to_departments
(2, 51); -- access_attendance

-- Operations Staff / Cashier (role_id=3) permissions - Process payments, print receipts, queue actions, shift management
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
(3, 1),  -- view_dashboard
(3, 3),  -- view_products
(3, 5),  -- view_staff
(3, 7),  -- view_orders
(3, 8),  -- accept_payments
(3, 9),  -- view_payments
(3, 10), -- print_receipts
(3, 13), -- view_voids
(3, 16), -- view_discounts
(3, 27), -- view_bar_queue
(3, 28), -- view_kitchen_queue
(3, 29), -- mark_bar_items_done
(3, 30), -- mark_kitchen_items_done
(3, 31), -- reprint_bar_ticket
(3, 32), -- reprint_kitchen_ticket
(3, 39), -- manage_pos
-- Shift Management for Cashiers
(3, 43), -- close_shift
(3, 44), -- view_shift_summary
(3, 46), -- print_shift_report
-- Payment Management for Cashiers
(3, 49), -- split_bill
(3, 50), -- transfer_table_orders
(3, 51); -- access_attendance

-- ============================================================================
-- SEED DATA: Branches (multi-branch)
-- ============================================================================

INSERT INTO branches (id, name, code, active) VALUES (1, 'Main Branch', 'MAIN', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ============================================================================
-- SEED DATA: Users - Rabbit Alley Staff (bcrypt hash for "password")
-- Default password for all accounts: "password". All assigned to branch_id 1.
-- ============================================================================

INSERT INTO users (id, employee_id, name, email, password_hash, role_id, branch_id, nickname, allowance, hourly, active) VALUES
-- MANAGERS / ADMIN (role_id = 1)
(1, 'MGR001', 'Angelo Val Morante', 'gelo@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Gelo', 500, 0, 1),
(2, 'MGR002', 'Jedd Kris Paul Patio', 'jedd@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Jedd', 500, 0, 1),
(3, 'MGR003', 'Len Gabriel Liwanag', 'gab@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Gab', 500, 0, 1),
(4, 'MGR004', 'Martin Tolentino', 'monk@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Monk', 500, 0, 1),
(5, 'GL', 'Len Gabriel Liwanag (GL)', 'gl@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'GL', 500, 0, 1),
(6, 'ADMIN', 'System Administrator', 'admin@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Admin', 500, 0, 1),
(7, 'MGR', 'Default Manager Account', 'mgr@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 1, 1, 'Manager', 500, 0, 1),

-- WAITERS (role_id = 2 - Staff)
(8, 'WTR001', 'Christian', 'christian@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Christian', 350, 50, 1),
(9, 'WTR002', 'Jhovi', 'jhovi@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Jhovi', 350, 50, 1),
(10, 'WTR003', 'Keith', 'keith@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Keith', 350, 50, 1),
(11, 'WTR004', 'Marlon', 'marlon@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Marlon', 350, 50, 1),

-- WAITRESS (role_id = 2 - Staff)
(12, 'WTS001', 'Nikka', 'nikka@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Nikka', 350, 50, 1),
(13, 'WTS002', 'Yuna', 'yuna@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Yuna', 350, 50, 1),
(14, 'WTS003', 'Kath', 'kath@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Kath', 350, 50, 1),
(15, 'WTS004', 'Joy', 'joy@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Joy', 350, 50, 1),

-- BARTENDERS (role_id = 3 - Operations Staff / Cashier)
(16, 'BAR001', 'Toyskie', 'toyskie@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 3, 1, 'Toyskie', 400, 60, 1),
(17, 'BAR002', 'Romgel', 'romgel@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 3, 1, 'Romgel', 400, 60, 1),

-- MODELS / LADIES (role_id = 2 - Staff; these are the LD hostesses selectable in the POS)
(18, 'MDL001', 'Angelica Santos',  'angelica@rabbitalley.local', '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Angel',  300, 0, 1),
(19, 'MDL002', 'Bianca Reyes',     'bianca@rabbitalley.local',   '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Bianca', 300, 0, 1),
(20, 'MDL003', 'Clarisse Dela Cruz','clarisse@rabbitalley.local','$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Cla',    300, 0, 1),
(21, 'MDL004', 'Diana Villanueva', 'diana@rabbitalley.local',    '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Diana',  300, 0, 1),
(22, 'MDL005', 'Elena Cruz',       'elena@rabbitalley.local',    '$2b$10$B4oc/jK4Bx5OBvUzeDu7Berro8sqOpPnCKkigopy0Eg2FF3FGmKSG', 2, 1, 'Elena',  300, 0, 1)

ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  email = VALUES(email),
  password_hash = VALUES(password_hash),
  role_id = VALUES(role_id),
  branch_id = VALUES(branch_id),
  nickname = VALUES(nickname),
  allowance = VALUES(allowance),
  hourly = VALUES(hourly),
  active = VALUES(active);

-- ============================================================================
-- SEED DATA: POS Tables (Lounge, Club, LD) - Branch 1
-- ============================================================================

INSERT INTO pos_tables (branch_id, id, name, area, status, current_order_id) VALUES
(1, 'L1', 'L1', 'Lounge', 'available', NULL),
(1, 'L2', 'L2', 'Lounge', 'available', NULL),
(1, 'L3', 'L3', 'Lounge', 'available', NULL),
(1, 'L4', 'L4', 'Lounge', 'available', NULL),
(1, 'L5', 'L5', 'Lounge', 'available', NULL),
(1, 'L6', 'L6', 'Lounge', 'available', NULL),
(1, 'C1', 'C1', 'Club', 'available', NULL),
(1, 'C2', 'C2', 'Club', 'available', NULL),
(1, 'C3', 'C3', 'Club', 'available', NULL),
(1, 'C4', 'C4', 'Club', 'available', NULL),
(1, 'C5', 'C5', 'Club', 'available', NULL),
(1, 'C6', 'C6', 'Club', 'available', NULL),
(1, 'C7', 'C7', 'Club', 'available', NULL),
(1, 'C8', 'C8', 'Club', 'available', NULL),
(1, 'LD1', 'LD1', 'LD', 'available', NULL),
(1, 'LD2', 'LD2', 'LD', 'available', NULL),
(1, 'LD3', 'LD3', 'LD', 'available', NULL),
(1, 'LD4', 'LD4', 'LD', 'available', NULL)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  area = VALUES(area);

-- ============================================================================
-- SEED DATA: Products - Rabbit Alley Garden Bar & Bistro Menu
-- ============================================================================

INSERT INTO products (sku, name, description, category, department, price, cost, commission, status) VALUES
-- SOUPS
('SOUP-001', 'Sinigang na Kambing', 'Best Seller', 'Soups', 'Kitchen', 558.00, 300.00, 0.00, 'active'),
('SOUP-002', 'Crab and Corn Soup (Regular)', '', 'Soups', 'Kitchen', 138.00, 70.00, 0.00, 'active'),
('SOUP-003', 'Crab and Corn Soup (Large)', '', 'Soups', 'Kitchen', 488.00, 250.00, 0.00, 'active'),
('SOUP-004', 'Cream of Mushroom Soup (Regular)', '', 'Soups', 'Kitchen', 138.00, 70.00, 0.00, 'active'),
('SOUP-005', 'Cream of Mushroom Soup (Large)', '', 'Soups', 'Kitchen', 488.00, 250.00, 0.00, 'active'),
('SOUP-006', 'Braised Beef Wonton Soup (Regular)', 'Best Seller', 'Soups', 'Kitchen', 268.00, 140.00, 0.00, 'active'),
('SOUP-007', 'Braised Beef Wonton Soup (Large)', 'Best Seller', 'Soups', 'Kitchen', 488.00, 250.00, 0.00, 'active'),

-- SALAD & SANDWICHES
('SAL-001', 'Kani Salad (Regular)', 'Best Seller', 'Salad & Sandwiches', 'Kitchen', 258.00, 130.00, 0.00, 'active'),
('SAL-002', 'Kani Salad (Sharing)', 'Best Seller', 'Salad & Sandwiches', 'Kitchen', 488.00, 250.00, 0.00, 'active'),
('SAL-003', 'Cucumber Salad', '', 'Salad & Sandwiches', 'Kitchen', 158.00, 80.00, 0.00, 'active'),
('SAL-004', 'RabbitAlley Salad (Regular)', '', 'Salad & Sandwiches', 'Kitchen', 208.00, 100.00, 0.00, 'active'),
('SAL-005', 'RabbitAlley Salad (Sharing)', '', 'Salad & Sandwiches', 'Kitchen', 388.00, 200.00, 0.00, 'active'),
('SAL-006', 'Shawarma Salad', '', 'Salad & Sandwiches', 'Kitchen', 168.00, 85.00, 0.00, 'active'),
('SAL-007', 'Angus Beef Burger', '', 'Salad & Sandwiches', 'Kitchen', 388.00, 200.00, 0.00, 'active'),
('SAL-008', 'Hangar Shawarma', 'Best Seller', 'Salad & Sandwiches', 'Kitchen', 188.00, 95.00, 0.00, 'active'),
('SAL-009', 'Kebab Shawarma', '', 'Salad & Sandwiches', 'Kitchen', 208.00, 105.00, 0.00, 'active'),
('SAL-010', 'Quesadilla - Four Cheese', '', 'Salad & Sandwiches', 'Kitchen', 158.00, 80.00, 0.00, 'active'),
('SAL-011', 'Quesadilla - Shawarma Beef', '', 'Salad & Sandwiches', 'Kitchen', 188.00, 95.00, 0.00, 'active'),
('SAL-012', 'Quesadilla - Pepperoni', '', 'Salad & Sandwiches', 'Kitchen', 208.00, 105.00, 0.00, 'active'),
('SAL-013', 'Quesadilla - Creamy Spinach', '', 'Salad & Sandwiches', 'Kitchen', 208.00, 105.00, 0.00, 'active'),
('SAL-014', 'Chicken Burger - Original', '', 'Salad & Sandwiches', 'Kitchen', 188.00, 95.00, 0.00, 'active'),
('SAL-015', 'Chicken Burger - Flavored', '', 'Salad & Sandwiches', 'Kitchen', 208.00, 105.00, 0.00, 'active'),

-- STARTERS / BAR BITES
('START-001', 'Mixed Nuts', '', 'Starters / Bar Bites', 'Bar', 138.00, 70.00, 0.00, 'active'),
('START-002', 'Mixed Fruits', '', 'Starters / Bar Bites', 'Kitchen', 258.00, 130.00, 0.00, 'active'),
('START-003', 'Crackers Platter', '', 'Starters / Bar Bites', 'Bar', 138.00, 70.00, 0.00, 'active'),
('START-004', 'Street Food Platter', '', 'Starters / Bar Bites', 'Kitchen', 188.00, 95.00, 0.00, 'active'),
('START-005', 'Sizzling Cheese Corn', '', 'Starters / Bar Bites', 'Kitchen', 218.00, 110.00, 0.00, 'active'),
('START-006', 'Dumplings in Chili Oil', 'Best Seller', 'Starters / Bar Bites', 'Kitchen', 178.00, 90.00, 0.00, 'active'),
('START-007', 'Sizzling Tofu', '', 'Starters / Bar Bites', 'Kitchen', 198.00, 100.00, 0.00, 'active'),
('START-008', 'Flavored Fries', 'BBQ / Cheese / Sour Cream', 'Starters / Bar Bites', 'Kitchen', 188.00, 95.00, 0.00, 'active'),
('START-009', 'Shawarma Fries', '', 'Starters / Bar Bites', 'Kitchen', 208.00, 105.00, 0.00, 'active'),
('START-010', 'RA Nachos', 'Best Seller', 'Starters / Bar Bites', 'Kitchen', 238.00, 120.00, 0.00, 'active'),
('START-011', 'Shawarma Nachos', '', 'Starters / Bar Bites', 'Kitchen', 258.00, 130.00, 0.00, 'active'),
('START-012', 'Jalapeno Cheese Sticks', '', 'Starters / Bar Bites', 'Kitchen', 198.00, 100.00, 0.00, 'active'),
('START-013', 'Salmon Sashimi', 'Best Seller', 'Starters / Bar Bites', 'Kitchen', 338.00, 170.00, 0.00, 'active'),
('START-014', 'Tokwat Baboy', 'Best Seller', 'Starters / Bar Bites', 'Kitchen', 318.00, 160.00, 0.00, 'active'),
('START-015', 'Chicharong Bulaklak', 'Best Seller', 'Starters / Bar Bites', 'Kitchen', 248.00, 125.00, 0.00, 'active'),
('START-016', 'Creamy Spinach Dip', '', 'Starters / Bar Bites', 'Kitchen', 258.00, 130.00, 0.00, 'active'),
('START-017', 'RabbitAlley Tacos', 'Sisig / Habanero Chicken / Camaron', 'Starters / Bar Bites', 'Kitchen', 238.00, 120.00, 0.00, 'active'),

-- PASTA
('PASTA-001', 'Porcini and Truffle Pasta (Regular)', 'Best Seller', 'Pasta', 'Kitchen', 448.00, 225.00, 0.00, 'active'),
('PASTA-002', 'Porcini and Truffle Pasta (Sharing)', 'Best Seller', 'Pasta', 'Kitchen', 888.00, 450.00, 0.00, 'active'),
('PASTA-003', 'Gambas al Ajillo Pasta (Regular)', '', 'Pasta', 'Kitchen', 368.00, 185.00, 0.00, 'active'),
('PASTA-004', 'Gambas al Ajillo Pasta (Sharing)', '', 'Pasta', 'Kitchen', 708.00, 355.00, 0.00, 'active'),
('PASTA-005', 'Creamy Carbonara (Regular)', 'Best Seller', 'Pasta', 'Kitchen', 308.00, 155.00, 0.00, 'active'),
('PASTA-006', 'Creamy Carbonara (Sharing)', 'Best Seller', 'Pasta', 'Kitchen', 598.00, 300.00, 0.00, 'active'),
('PASTA-007', 'Shrimp in Aligue Pasta (Regular)', '', 'Pasta', 'Kitchen', 408.00, 205.00, 0.00, 'active'),
('PASTA-008', 'Shrimp in Aligue Pasta (Sharing)', '', 'Pasta', 'Kitchen', 798.00, 400.00, 0.00, 'active'),
('PASTA-009', 'Spanish Sardines Pasta (Regular)', '', 'Pasta', 'Kitchen', 458.00, 230.00, 0.00, 'active'),
('PASTA-010', 'Spanish Sardines Pasta (Sharing)', '', 'Pasta', 'Kitchen', 888.00, 445.00, 0.00, 'active'),
('PASTA-011', 'Cannelloni Bolognese (Regular)', '', 'Pasta', 'Kitchen', 458.00, 230.00, 0.00, 'active'),
('PASTA-012', 'Cannelloni Bolognese (Sharing)', '', 'Pasta', 'Kitchen', 888.00, 445.00, 0.00, 'active'),

-- CHICKEN
('CHKN-001', 'Grilled Thai Chicken (Regular)', '', 'Chicken', 'Kitchen', 258.00, 130.00, 0.00, 'active'),
('CHKN-002', 'Grilled Thai Chicken (Sharing)', '', 'Chicken', 'Kitchen', 488.00, 245.00, 0.00, 'active'),
('CHKN-003', 'Chicken Katsu', '', 'Chicken', 'Kitchen', 328.00, 165.00, 0.00, 'active'),
('CHKN-004', 'Chicken Katsu Curry', '', 'Chicken', 'Kitchen', 388.00, 195.00, 0.00, 'active'),
('CHKN-005', 'Chicken Parmiggiana (Regular)', '', 'Chicken', 'Kitchen', 298.00, 150.00, 0.00, 'active'),
('CHKN-006', 'Chicken Parmiggiana (Sharing)', '', 'Chicken', 'Kitchen', 488.00, 245.00, 0.00, 'active'),
('CHKN-007', 'Kanto Fried Chicken (Regular)', 'Best Seller', 'Chicken', 'Kitchen', 308.00, 155.00, 0.00, 'active'),
('CHKN-008', 'Kanto Fried Chicken (Sharing)', 'Best Seller', 'Chicken', 'Kitchen', 588.00, 295.00, 0.00, 'active'),
('CHKN-009', 'Fried Chicken Wings (Half)', 'Best Seller', 'Chicken', 'Kitchen', 398.00, 200.00, 0.00, 'active'),
('CHKN-010', 'Fried Chicken Wings (Full)', 'Best Seller', 'Chicken', 'Kitchen', 658.00, 330.00, 0.00, 'active'),

-- SEAFOOD
('SEA-001', 'Creamy Garlic Shrimp', '', 'Seafood', 'Kitchen', 398.00, 200.00, 0.00, 'active'),
('SEA-002', 'Fish and Chips', '', 'Seafood', 'Kitchen', 328.00, 165.00, 0.00, 'active'),
('SEA-003', 'Baked Garlic Tahong', '', 'Seafood', 'Kitchen', 428.00, 215.00, 0.00, 'active'),
('SEA-004', 'Shrimp Tempura', '', 'Seafood', 'Kitchen', 298.00, 150.00, 0.00, 'active'),
('SEA-005', 'Garlic Butter Shrimp', 'Best Seller', 'Seafood', 'Kitchen', 368.00, 185.00, 0.00, 'active'),
('SEA-006', 'Shrimp in Aligue Butter', '', 'Seafood', 'Kitchen', 388.00, 195.00, 0.00, 'active'),
('SEA-007', 'Gambas Al Ajillo', 'Best Seller', 'Seafood', 'Kitchen', 358.00, 180.00, 0.00, 'active'),
('SEA-008', 'Salted Egg Shrimp', '', 'Seafood', 'Kitchen', 398.00, 200.00, 0.00, 'active'),
('SEA-009', 'Fried Calamares (Regular)', '', 'Seafood', 'Kitchen', 348.00, 175.00, 0.00, 'active'),
('SEA-010', 'Fried Calamares (Large)', '', 'Seafood', 'Kitchen', 668.00, 335.00, 0.00, 'active'),

-- PORK
('PORK-001', 'Pork Tonkatsu Platter', '', 'Pork', 'Kitchen', 548.00, 275.00, 0.00, 'active'),
('PORK-002', 'Sizzling Pork Sisig', 'Best Seller', 'Pork', 'Kitchen', 268.00, 135.00, 0.00, 'active'),
('PORK-003', 'Sausage & Peppers', '', 'Pork', 'Kitchen', 298.00, 150.00, 0.00, 'active'),
('PORK-004', 'Crispy Pata Platter', 'Best Seller', 'Pork', 'Kitchen', 1088.00, 545.00, 0.00, 'active'),
('PORK-005', 'Kare-Kare Crispy Pata', '', 'Pork', 'Kitchen', 1188.00, 595.00, 0.00, 'active'),
('PORK-006', 'Lechon Kawali', '', 'Pork', 'Kitchen', 448.00, 225.00, 0.00, 'active'),
('PORK-007', 'Binondo Kikiam', 'Best Seller', 'Pork', 'Kitchen', 448.00, 225.00, 0.00, 'active'),
('PORK-008', 'Grilled Hungarian Sausage', '', 'Pork', 'Kitchen', 268.00, 135.00, 0.00, 'active'),
('PORK-009', 'Lechon Macau', 'Best Seller', 'Pork', 'Kitchen', 368.00, 185.00, 0.00, 'active'),
('PORK-010', 'Pork BBQ Skewers', '', 'Pork', 'Kitchen', 308.00, 155.00, 0.00, 'active'),
('PORK-011', 'Grilled Pork Chops (Regular)', '', 'Pork', 'Kitchen', 348.00, 175.00, 0.00, 'active'),
('PORK-012', 'Grilled Pork Chops (Large)', '', 'Pork', 'Kitchen', 548.00, 275.00, 0.00, 'active'),

-- BEEF / OTHERS
('BEEF-001', 'Grilled Wagyu Cubes', 'Best Seller', 'Beef / Others', 'Kitchen', 438.00, 220.00, 0.00, 'active'),
('BEEF-002', 'Steak and Fries', 'Best Seller', 'Beef / Others', 'Kitchen', 1088.00, 545.00, 0.00, 'active'),
('BEEF-003', 'Beef Chelo Kebab', '', 'Beef / Others', 'Kitchen', 288.00, 145.00, 0.00, 'active'),
('BEEF-004', 'Beef Truffle Lengua', 'Best Seller', 'Beef / Others', 'Kitchen', 498.00, 250.00, 0.00, 'active'),
('BEEF-005', 'Beef BBQ Skewers', '', 'Beef / Others', 'Kitchen', 498.00, 250.00, 0.00, 'active'),
('BEEF-006', 'Kaldereta - Beef', '', 'Beef / Others', 'Kitchen', 558.00, 280.00, 0.00, 'active'),
('BEEF-007', 'Kambing', '', 'Beef / Others', 'Kitchen', 598.00, 300.00, 0.00, 'active'),

-- GROUP MEALS
('GRP-001', 'RabbitAlley Sampler', 'Good for 8-10 pax', 'Group Meals', 'Kitchen', 4000.00, 2000.00, 0.00, 'active'),
('GRP-002', 'Inuman Sampler', 'Good for 8-10 pax', 'Group Meals', 'Kitchen', 4000.00, 2000.00, 0.00, 'active'),
('GRP-003', 'Filipino Sampler', 'Good for 6-8 pax', 'Group Meals', 'Kitchen', 3099.00, 1550.00, 0.00, 'active'),
('GRP-004', 'International Sampler', 'Good for 8-10 pax', 'Group Meals', 'Kitchen', 4000.00, 2000.00, 0.00, 'active'),
('GRP-005', 'Asian Cuisine Sampler', 'Good for 8-10 pax', 'Group Meals', 'Kitchen', 4000.00, 2000.00, 0.00, 'active'),

-- HARD LIQUOR
('LIQ-001', 'Soju', '', 'Hard Liquor', 'Bar', 500.00, 250.00, 50.00, 'active'),
('LIQ-002', 'The BaR Premium Dry Gin', 'Pink Gin / Lime Gin', 'Hard Liquor', 'Bar', 900.00, 450.00, 90.00, 'active'),
('LIQ-003', 'GSM Blue Mojito 1L', '', 'Hard Liquor', 'Bar', 1000.00, 500.00, 100.00, 'active'),
('LIQ-004', 'Alfonso I Light', '', 'Hard Liquor', 'Bar', 1300.00, 650.00, 130.00, 'active'),
('LIQ-005', 'Fundador Light', '', 'Hard Liquor', 'Bar', 1500.00, 750.00, 150.00, 'active'),
('LIQ-006', 'Bacardi Superior', '', 'Hard Liquor', 'Bar', 1700.00, 850.00, 170.00, 'active'),
('LIQ-007', 'Bacardi Gold', '', 'Hard Liquor', 'Bar', 1700.00, 850.00, 170.00, 'active'),
('LIQ-008', 'Jose Cuervo', '', 'Hard Liquor', 'Bar', 2200.00, 1100.00, 220.00, 'active'),
('LIQ-009', 'Jose Cuervo 1L', '', 'Hard Liquor', 'Bar', 3000.00, 1500.00, 300.00, 'active'),
('LIQ-010', 'JW Black Label', '', 'Hard Liquor', 'Bar', 3200.00, 1600.00, 320.00, 'active'),
('LIQ-011', 'Jack Daniels Whiskey', '', 'Hard Liquor', 'Bar', 3700.00, 1850.00, 370.00, 'active'),
('LIQ-012', 'JW Double Black', '', 'Hard Liquor', 'Bar', 4200.00, 2100.00, 420.00, 'active'),
('LIQ-013', 'JW Blue Label', '', 'Hard Liquor', 'Bar', 14000.00, 7000.00, 1400.00, 'active'),
('LIQ-014', 'Hennessy VS', '', 'Hard Liquor', 'Bar', 4200.00, 2100.00, 420.00, 'active'),
('LIQ-015', 'Dalmore 12 yrs', '', 'Hard Liquor', 'Bar', 6900.00, 3450.00, 690.00, 'active'),

-- WINES
('WINE-001', 'Yellow Tail Pink Moscato', '', 'Wines', 'Bar', 2000.00, 1000.00, 200.00, 'active'),
('WINE-002', 'Yellow Tail Moscato', '', 'Wines', 'Bar', 2000.00, 1000.00, 200.00, 'active'),
('WINE-003', 'Yellow Tail Merlot', '', 'Wines', 'Bar', 2000.00, 1000.00, 200.00, 'active'),

-- BEERS
('BEER-001', 'San Miguel Light', '', 'Beers', 'Bar', 150.00, 75.00, 15.00, 'active'),
('BEER-002', 'San Miguel Pale Pilsen', '', 'Beers', 'Bar', 150.00, 75.00, 15.00, 'active'),
('BEER-003', 'San Miguel Apple', '', 'Beers', 'Bar', 150.00, 75.00, 15.00, 'active'),
('BEER-004', 'Red Horse Stallion', '', 'Beers', 'Bar', 200.00, 100.00, 20.00, 'active'),
('BEER-005', 'Smirnoff Mule', '', 'Beers', 'Bar', 200.00, 100.00, 20.00, 'active'),
('BEER-006', 'SML/SMB/SMA Bucket', '6 bottles', 'Beers', 'Bar', 598.00, 300.00, 60.00, 'active'),
('BEER-007', 'RH/Mule Bucket', '6 bottles', 'Beers', 'Bar', 720.00, 360.00, 72.00, 'active'),

-- NON-ALCOHOLIC
('NA-001', 'Bottled Water', '', 'Non-Alcoholic', 'Bar', 75.00, 38.00, 0.00, 'active'),
('NA-002', 'Soda (Can)', '', 'Non-Alcoholic', 'Bar', 90.00, 45.00, 0.00, 'active'),
('NA-003', 'Soda (Carafe)', '', 'Non-Alcoholic', 'Bar', 250.00, 125.00, 0.00, 'active'),
('NA-004', 'Soda (Bottle)', '', 'Non-Alcoholic', 'Bar', 300.00, 150.00, 0.00, 'active'),
('NA-005', 'Coffee', '', 'Non-Alcoholic', 'Bar', 128.00, 65.00, 0.00, 'active'),
('NA-006', 'Iced Coffee', '', 'Non-Alcoholic', 'Bar', 168.00, 85.00, 0.00, 'active'),
('NA-007', 'Iced Tea (Regular)', '', 'Non-Alcoholic', 'Bar', 90.00, 45.00, 0.00, 'active'),
('NA-008', 'Iced Tea (Pitcher)', '', 'Non-Alcoholic', 'Bar', 250.00, 125.00, 0.00, 'active'),
('NA-009', 'Cucumber Lemonade (Regular)', '', 'Non-Alcoholic', 'Bar', 90.00, 45.00, 0.00, 'active'),
('NA-010', 'Cucumber Lemonade (Pitcher)', '', 'Non-Alcoholic', 'Bar', 250.00, 125.00, 0.00, 'active'),
('NA-011', 'Candy', '', 'Non-Alcoholic', 'Bar', 25.00, 13.00, 0.00, 'active'),
('NA-012', 'Cigarettes', '', 'Non-Alcoholic', 'Bar', 250.00, 125.00, 0.00, 'active'),

-- PROMOS (Happy Hour)
('PROMO-001', 'Happy Hour SML/SMB/SMA (Bottle)', 'Lounge 6PM-9PM', 'Promos', 'Bar', 80.00, 40.00, 8.00, 'active'),
('PROMO-002', 'Happy Hour SML/SMB/SMA (Bucket)', 'Lounge 6PM-9PM', 'Promos', 'Bar', 450.00, 225.00, 45.00, 'active'),
('PROMO-003', 'Happy Hour RH/Mule (Bottle)', 'Lounge 6PM-9PM', 'Promos', 'Bar', 100.00, 50.00, 10.00, 'active'),
('PROMO-004', 'Happy Hour RH/Mule (Bucket)', 'Lounge 6PM-9PM', 'Promos', 'Bar', 550.00, 275.00, 55.00, 'active'),

-- ============================================================================
-- ALL YOU CAN EAT SUNDAYS - WINGS (Sundays Only)
-- ============================================================================
('AYCE-001', 'AYCE Wings Sunday Special', 'All You Can Eat Wings - Sundays Only', 'AYCE Sundays', 'Kitchen', 648.00, 300.00, 65.00, 'active'),

-- AYCE WINGS FLAVORS (Add-on orders for tracking, price included in AYCE)
('AYCE-W01', 'Wings - Original', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W02', 'Wings - Classic Buffalo', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W03', 'Wings - Honey Mustard', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W04', 'Wings - Texas BBQ', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W05', 'Wings - Honey Sriracha', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W06', 'Wings - Honey Garlic', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W07', 'Wings - Soy Garlic', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W08', 'Wings - Garlic Parmesan', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W09', 'Wings - Memphis Dry Rub', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W10', 'Wings - Cheesy Cheetos', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W11', 'Wings - Salted Egg', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W12', 'Wings - Wasabi', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W13', 'Wings - Galbi', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W14', 'Wings - Gochu Jang', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W15', 'Wings - Garlic Pesto', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W16', 'Wings - Sour Cream', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W17', 'Wings - Kamikaze', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W18', 'Wings - Habanero Buffalo', 'AYCE Sunday Flavor - SPICY', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W19', 'Wings - Carolina Reaper', 'AYCE Sunday Flavor - EXTREME SPICY', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-W20', 'Wings - Carolina Mop Sauce', 'AYCE Sunday Flavor', 'AYCE Wings', 'Kitchen', 0.00, 0.00, 0.00, 'active'),

-- AYCE SIDES (Add-on orders for tracking, price included in AYCE)
('AYCE-S01', 'Side - Mexican Corn', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-S02', 'Side - Mac & Cheese', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-S03', 'Side - Shawarma Rice', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-S04', 'Side - Coleslaw', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-S05', 'Side - Fries', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),
('AYCE-S06', 'Side - Iced Tea', 'AYCE Sunday Side', 'AYCE Sides', 'Bar', 0.00, 0.00, 0.00, 'active'),
('AYCE-S07', 'Side - Rice', 'AYCE Sunday Side', 'AYCE Sides', 'Kitchen', 0.00, 0.00, 0.00, 'active'),

-- LADIES DRINK (LD) - Commission-based drinks ordered for hostess/model
('LD-001', 'San Mig Light',         'Ladies Drink - Beer', 'Ladies Drink', 'LD', 350.00, 150.00, 50.00, 'active'),
('LD-002', 'San Mig Pale Pilsen',   'Ladies Drink - Beer', 'Ladies Drink', 'LD', 350.00, 150.00, 50.00, 'active'),
('LD-003', 'Red Horse',             'Ladies Drink - Beer', 'Ladies Drink', 'LD', 350.00, 150.00, 50.00, 'active'),
('LD-004', 'Coke Float',            'Ladies Drink - Softdrink', 'Ladies Drink', 'LD', 250.00, 100.00, 40.00, 'active'),
('LD-005', 'Iced Tea',              'Ladies Drink - Non-Alcoholic', 'Ladies Drink', 'LD', 200.00, 80.00, 35.00, 'active'),
('LD-006', 'House Wine (Red)',      'Ladies Drink - Wine', 'Ladies Drink', 'LD', 450.00, 200.00, 70.00, 'active'),
('LD-007', 'House Wine (White)',    'Ladies Drink - Wine', 'Ladies Drink', 'LD', 450.00, 200.00, 70.00, 'active'),
('LD-008', 'Vodka Soda',            'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 400.00, 180.00, 60.00, 'active'),
('LD-009', 'Gin Tonic',             'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 400.00, 180.00, 60.00, 'active'),
('LD-010', 'Margarita',             'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 500.00, 220.00, 75.00, 'active'),
('LD-011', 'Mojito',                'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 500.00, 220.00, 75.00, 'active'),
('LD-012', 'Strawberry Daiquiri',   'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 500.00, 220.00, 75.00, 'active'),
('LD-013', 'Sex on the Beach',      'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 550.00, 240.00, 80.00, 'active'),
('LD-014', 'Blue Lagoon',           'Ladies Drink - Cocktail', 'Ladies Drink', 'LD', 550.00, 240.00, 80.00, 'active'),
('LD-015', 'Tequila Shot',          'Ladies Drink - Shot', 'Ladies Drink', 'LD', 300.00, 120.00, 50.00, 'active')

ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  category = VALUES(category),
  department = VALUES(department),
  price = VALUES(price),
  cost = VALUES(cost),
  commission = VALUES(commission),
  status = VALUES(status);

-- ============================================================================
-- SEED DATA: Discounts
-- ============================================================================

INSERT INTO discounts (id, name, type, category, applicable_to, value, valid_from, valid_to, status, creator_id) VALUES
(1, 'Senior Citizen', 'Standalone', 'Senior', 'Order', '20%', NULL, NULL, 'approved', 1),
(2, 'PWD Discount', 'Standalone', 'PWD', 'Order', '20%', NULL, NULL, 'approved', 1),
(3, 'Happy Hour', 'Applied', 'Happy Hour', 'Product', '₱50.00', NULL, NULL, 'approved', 1),
(4, 'VIP Member', 'Standalone', 'VIP', 'Order', '15%', NULL, NULL, 'approved', 1),
(5, 'Summer Promo', 'Applied', 'Seasonal', 'Category', '10%', '2026-03-01', '2026-12-31', 'approved', 1),
(6, 'Staff Discount', 'Standalone', 'Staff', 'Order', '20%', NULL, NULL, 'approved', 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), value = VALUES(value), status = VALUES(status);

-- ============================================================================
-- SEED DATA: Waiter Table Assignments
-- ============================================================================

INSERT IGNORE INTO waiter_table_assignments (branch_id, user_id, table_id) VALUES
(1, 8, 'L1'), (1, 8, 'L2'), (1, 8, 'L3'),
(1, 9, 'L4'), (1, 9, 'L5'), (1, 9, 'L6'),
(1, 10, 'C1'), (1, 10, 'C2'), (1, 10, 'C3'), (1, 10, 'C4'),
(1, 11, 'C5'), (1, 11, 'C6'), (1, 11, 'C7'), (1, 11, 'C8'),
(1, 12, 'LD1'), (1, 12, 'LD2'), (1, 13, 'LD3'), (1, 13, 'LD4');

-- ============================================================================
-- SEED DATA: Printers & Hardware Configuration
-- ============================================================================

INSERT INTO printers (id, name, interface, type, branch_id, active) VALUES
(1, 'Counter Cashier Printer', 'tcp://192.168.1.100:9100', 'epson', 1, 1),
(2, 'Kitchen Order Chit Printer', 'tcp://192.168.1.101:9100', 'epson', 1, 1),
(3, 'Bar Beverage Chit Printer', 'tcp://192.168.1.102:9100', 'epson', 1, 1)
ON DUPLICATE KEY UPDATE name = VALUES(name), interface = VALUES(interface), active = VALUES(active);

-- ============================================================================
-- SEED DATA: Product Stock & Area Pricing
-- ============================================================================
-- Give all products an initial inventory stock count of 150 units on hand
INSERT IGNORE INTO product_stock (product_id, qty_on_hand)
SELECT id, 150.000 FROM products;

-- Set up area pricing (Lounge / Club / LD) for select products
INSERT IGNORE INTO product_area_prices (product_id, area, price)
SELECT id, 'Lounge', price FROM products WHERE category IN ('Hard Liquor', 'Beers', 'Wines');

INSERT IGNORE INTO product_area_prices (product_id, area, price)
SELECT id, 'Club', ROUND(price * 1.10, 2) FROM products WHERE category IN ('Hard Liquor', 'Beers', 'Wines');

INSERT IGNORE INTO product_area_prices (product_id, area, price)
SELECT id, 'LD', price FROM products WHERE department = 'LD';

-- ============================================================================
-- SEED DATA: Order Number Sequences & Table Sessions
-- ============================================================================
INSERT INTO order_number_sequences (branch_id, seq_date, last_seq) VALUES
(1, CURDATE(), 15)
ON DUPLICATE KEY UPDATE last_seq = 15;

INSERT INTO table_sessions (id, branch_id, table_id, waiter_id, opened_at, closed_at, status, closed_by) VALUES
(1, 1, 'L1', 'WTR001', DATE_SUB(NOW(), INTERVAL 3 HOUR), DATE_SUB(NOW(), INTERVAL 1 HOUR), 'closed', 'Toyskie'),
(2, 1, 'C3', 'WTS001', DATE_SUB(NOW(), INTERVAL 4 HOUR), DATE_SUB(NOW(), INTERVAL 2 HOUR), 'closed', 'Toyskie'),
(3, 1, 'LD2', 'WTR002', DATE_SUB(NOW(), INTERVAL 2 HOUR), DATE_SUB(NOW(), INTERVAL 30 MINUTE), 'closed', 'Toyskie'),
(4, 1, 'L2', 'WTR001', DATE_SUB(NOW(), INTERVAL 45 MINUTE), NULL, 'open', NULL),
(5, 1, 'C1', 'WTR003', DATE_SUB(NOW(), INTERVAL 30 MINUTE), NULL, 'open', NULL),
(6, 1, 'C2', 'WTR003', DATE_SUB(NOW(), INTERVAL 20 MINUTE), NULL, 'open', NULL),
(7, 1, 'LD1', 'WTS001', DATE_SUB(NOW(), INTERVAL 15 MINUTE), NULL, 'open', NULL),
(8, 1, 'L4', 'WTR002', DATE_SUB(NOW(), INTERVAL 50 MINUTE), DATE_SUB(NOW(), INTERVAL 40 MINUTE), 'closed', 'Angelo Val Morante')
ON DUPLICATE KEY UPDATE status = VALUES(status), closed_at = VALUES(closed_at);

-- Ensure status column supports voided and cancelled values if table already existed
ALTER TABLE orders MODIFY COLUMN status ENUM('pending','paid','voided','cancelled') NOT NULL DEFAULT 'pending';

-- ============================================================================
-- SEED DATA: Orders (Paid, Pending & Voided)
-- ============================================================================
INSERT INTO orders (id, branch_id, order_number, table_id, session_id, status, payment_method, subtotal, discount, tax, total, employee_id, order_date, voided_at, voided_by, voided_by_name) VALUES
(1, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0001'), 'L1', 1, 'paid', 'cash', 1339.29, 0.00, 160.71, 1500.00, 'WTR001', CURDATE(), NULL, NULL, NULL),
(2, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0002'), 'C3', 2, 'paid', 'gcash', 2857.14, 0.00, 342.86, 3200.00, 'WTS001', CURDATE(), NULL, NULL, NULL),
(3, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0003'), 'LD2', 3, 'paid', 'debit', 4017.86, 0.00, 482.14, 4500.00, 'WTR002', CURDATE(), NULL, NULL, NULL),
(4, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0004'), 'L2', 4, 'pending', NULL, 1650.00, 0.00, 198.00, 1848.00, 'WTR001', CURDATE(), NULL, NULL, NULL),
(5, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0005'), 'C1', 5, 'pending', NULL, 1964.29, 0.00, 235.71, 2200.00, 'WTR003', CURDATE(), NULL, NULL, NULL),
(6, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0006'), 'C2', 6, 'pending', NULL, 848.21, 0.00, 101.79, 950.00, 'WTR003', CURDATE(), NULL, NULL, NULL),
(7, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0007'), 'LD1', 7, 'pending', NULL, 1250.00, 0.00, 150.00, 1400.00, 'WTS001', CURDATE(), NULL, NULL, NULL),
(8, 1, CONCAT(DATE_FORMAT(CURDATE(), '%Y%m%d'), '-0008'), 'L4', 8, 'voided', NULL, 0.00, 0.00, 0.00, 0.00, 'WTR002', CURDATE(), NOW(), 1, 'Angelo Val Morante')
ON DUPLICATE KEY UPDATE status = VALUES(status), total = VALUES(total), voided_at = VALUES(voided_at);

-- Mark active tables as occupied
UPDATE pos_tables SET status = 'occupied', current_order_id = '4' WHERE id = 'L2' AND branch_id = 1;
UPDATE pos_tables SET status = 'occupied', current_order_id = '5' WHERE id = 'C1' AND branch_id = 1;
UPDATE pos_tables SET status = 'occupied', current_order_id = '6' WHERE id = 'C2' AND branch_id = 1;
UPDATE pos_tables SET status = 'occupied', current_order_id = '7' WHERE id = 'LD1' AND branch_id = 1;

-- ============================================================================
-- SEED DATA: Order Items (Food, Drinks, Ladies Drinks, Complimentary & Voided)
-- ============================================================================
INSERT INTO order_items (id, order_id, product_sku, product_name, quantity, unit_price, discount, subtotal, department, sent_to_dept, is_complimentary, served_by, special_request, is_voided, voided_by, voided_at, voided_by_name) VALUES
-- Order 1 (L1 - Paid)
(1, 1, 'PASTA-001', 'Porcini and Truffle Pasta (Regular)', 1, 448.00, 0.00, 448.00, 'Kitchen', 1, 0, NULL, 'Extra cheese', 0, NULL, NULL, NULL),
(2, 1, 'SEA-005', 'Garlic Butter Shrimp', 1, 368.00, 0.00, 368.00, 'Kitchen', 1, 0, NULL, NULL, 0, NULL, NULL, NULL),
(3, 1, 'BEER-006', 'SML/SMB/SMA Bucket', 1, 598.00, 0.00, 598.00, 'Bar', 1, 0, NULL, 'Ice cold', 0, NULL, NULL, NULL),
(4, 1, 'NA-001', 'Bottled Water', 2, 75.00, 0.00, 150.00, 'Bar', 1, 1, NULL, 'Complimentary house water', 0, NULL, NULL, NULL),

-- Order 2 (C3 - Paid)
(5, 2, 'LIQ-010', 'JW Black Label', 1, 3200.00, 0.00, 3200.00, 'Bar', 1, 0, NULL, 'With bucket of ice & soda water', 0, NULL, NULL, NULL),
(6, 2, 'PORK-002', 'Sizzling Pork Sisig', 1, 268.00, 0.00, 268.00, 'Kitchen', 1, 0, NULL, 'No raw egg', 0, NULL, NULL, NULL),
(7, 2, 'PORK-004', 'Crispy Pata Platter', 1, 1088.00, 0.00, 1088.00, 'Kitchen', 1, 0, NULL, 'Chopped', 0, NULL, NULL, NULL),
-- Voided item inside paid order 2
(8, 2, 'SEA-002', 'Fish and Chips', 1, 328.00, 0.00, 328.00, 'Kitchen', 1, 0, NULL, 'Customer cancelled due to wait time', 1, 1, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'Angelo Val Morante'),

-- Order 3 (LD2 - Paid with Ladies Drinks)
(9, 3, 'LIQ-008', 'Jose Cuervo', 1, 2200.00, 0.00, 2200.00, 'Bar', 1, 0, NULL, 'With orange slice and cinnamon', 0, NULL, NULL, NULL),
(10, 3, 'LD-008', 'Vodka Soda', 2, 400.00, 0.00, 800.00, 'LD', 1, 0, 18, 'For Angel (MDL001)', 0, NULL, NULL, NULL),
(11, 3, 'LD-010', 'Margarita', 3, 500.00, 0.00, 1500.00, 'LD', 1, 0, 19, 'For Bianca (MDL002)', 0, NULL, NULL, NULL),

-- Order 4 (L2 - Active Pending)
(12, 4, 'BEEF-001', 'Grilled Wagyu Cubes', 2, 438.00, 0.00, 876.00, 'Kitchen', 1, 0, NULL, 'Medium well', 0, NULL, NULL, NULL),
(13, 4, 'BEER-007', 'RH/Mule Bucket', 1, 720.00, 0.00, 720.00, 'Bar', 1, 0, NULL, 'Smirnoff Mule bucket', 0, NULL, NULL, NULL),
(14, 4, 'NA-003', 'Soda (Carafe)', 1, 250.00, 0.00, 250.00, 'Bar', 1, 0, NULL, 'Coke', 0, NULL, NULL, NULL),

-- Order 5 (C1 - Active Pending)
(15, 5, 'LIQ-001', 'Soju', 4, 500.00, 0.00, 2000.00, 'Bar', 1, 0, NULL, 'Chamisul Fresh', 0, NULL, NULL, NULL),
(16, 5, 'PORK-002', 'Sizzling Pork Sisig', 2, 268.00, 0.00, 536.00, 'Kitchen', 1, 0, NULL, 'Extra chili', 0, NULL, NULL, NULL),
-- Pending voided item in Order 5
(17, 5, 'SOUP-001', 'Sinigang na Kambing', 1, 558.00, 0.00, 558.00, 'Kitchen', 1, 0, NULL, 'Out of stock', 1, 2, DATE_SUB(NOW(), INTERVAL 15 MINUTE), 'Jedd Kris Paul Patio'),

-- Order 6 (C2 - Active Pending)
(18, 6, 'CHKN-009', 'Fried Chicken Wings (Half)', 1, 398.00, 0.00, 398.00, 'Kitchen', 1, 0, NULL, 'Buffalo flavor', 0, NULL, NULL, NULL),
(19, 6, 'BEER-001', 'San Miguel Light', 3, 150.00, 0.00, 450.00, 'Bar', 1, 0, NULL, NULL, 0, NULL, NULL, NULL),

-- Order 7 (LD1 - Active Pending with Ladies Drinks)
(20, 7, 'WINE-001', 'Yellow Tail Pink Moscato', 1, 2000.00, 0.00, 2000.00, 'Bar', 1, 0, NULL, 'Chilled with wine bucket', 0, NULL, NULL, NULL),
(21, 7, 'LD-011', 'Mojito', 1, 500.00, 0.00, 500.00, 'LD', 1, 0, 20, 'For Clarisse (MDL003)', 0, NULL, NULL, NULL),
(22, 7, 'LD-013', 'Sex on the Beach', 1, 550.00, 0.00, 550.00, 'LD', 1, 0, 21, 'For Diana (MDL004)', 0, NULL, NULL, NULL),

-- Order 8 (L4 - Full Voided Order)
(23, 8, 'GRP-001', 'RabbitAlley Sampler', 1, 4000.00, 0.00, 4000.00, 'Kitchen', 1, 0, NULL, 'Guest walked out before cooking started', 1, 1, DATE_SUB(NOW(), INTERVAL 40 MINUTE), 'Angelo Val Morante'),
(24, 8, 'LIQ-011', 'Jack Daniels Whiskey', 1, 3700.00, 0.00, 3700.00, 'Bar', 1, 0, NULL, 'Guest walked out before cooking started', 1, 1, DATE_SUB(NOW(), INTERVAL 40 MINUTE), 'Angelo Val Morante')
ON DUPLICATE KEY UPDATE product_name = VALUES(product_name), subtotal = VALUES(subtotal), is_voided = VALUES(is_voided);

-- Link order items to product IDs via SKU
UPDATE order_items oi JOIN products p ON p.sku = oi.product_sku SET oi.product_id = p.id WHERE oi.product_id IS NULL;

-- ============================================================================
-- SEED DATA: Void & Audit Log Records (Ensures Reports -> Voids is populated!)
-- ============================================================================
INSERT INTO void_log (branch_id, void_type, order_id, order_item_id, product_id, product_sku, product_name, quantity, unit_price, amount, table_id, session_id, voided_by, voided_by_name, voided_by_employee_id, voided_at, reason) VALUES
(1, 'item', 2, 8, NULL, 'SEA-002', 'Fish and Chips', 1, 328.00, 328.00, 'C3', 2, 1, 'Angelo Val Morante', 'MGR001', DATE_SUB(NOW(), INTERVAL 3 HOUR), 'Customer cancelled due to wait time'),
(1, 'item', 5, 17, NULL, 'SOUP-001', 'Sinigang na Kambing', 1, 558.00, 558.00, 'C1', 5, 2, 'Jedd Kris Paul Patio', 'MGR002', DATE_SUB(NOW(), INTERVAL 15 MINUTE), 'Kitchen out of goat meat'),
(1, 'order', 8, 23, NULL, 'GRP-001', 'RabbitAlley Sampler', 1, 4000.00, 4000.00, 'L4', 8, 1, 'Angelo Val Morante', 'MGR001', DATE_SUB(NOW(), INTERVAL 40 MINUTE), 'CANCEL - Guest emergency leave before serving'),
(1, 'order', 8, 24, NULL, 'LIQ-011', 'Jack Daniels Whiskey', 1, 3700.00, 3700.00, 'L4', 8, 1, 'Angelo Val Morante', 'MGR001', DATE_SUB(NOW(), INTERVAL 40 MINUTE), 'CANCEL - Guest emergency leave before serving'),
(1, 'item', 1, NULL, NULL, 'BEER-004', 'Red Horse Stallion', 2, 200.00, 400.00, 'L1', 1, 1, 'Angelo Val Morante', 'MGR001', DATE_SUB(NOW(), INTERVAL 5 HOUR), 'Changed order to San Mig Bucket'),
(1, 'item', 3, NULL, NULL, 'LD-001', 'San Mig Light (LD)', 1, 350.00, 350.00, 'LD2', 3, 5, 'Len Gabriel Liwanag (GL)', 'GL', DATE_SUB(NOW(), INTERVAL 2 HOUR), 'Mistakenly added duplicate LD item');

UPDATE void_log vl JOIN products p ON p.sku = vl.product_sku SET vl.product_id = p.id WHERE vl.product_id IS NULL;

-- ============================================================================
-- SEED DATA: Payroll Payouts & Commission Summaries
-- ============================================================================
INSERT INTO payouts (user_id, period_from, period_to, allowance, hours, commission, incentives, adjustments, deductions, total, status, approved_by) VALUES
(18, DATE_SUB(CURDATE(), INTERVAL 7 DAY), CURDATE(), 2100.00, 40.00, 1850.00, 500.00, 0.00, 200.00, 4250.00, 'approved', 1),
(19, DATE_SUB(CURDATE(), INTERVAL 7 DAY), CURDATE(), 2100.00, 42.00, 2400.00, 300.00, 0.00, 100.00, 4700.00, 'approved', 1),
(8, DATE_SUB(CURDATE(), INTERVAL 7 DAY), CURDATE(), 2450.00, 48.00, 850.00, 400.00, 0.00, 150.00, 5950.00, 'approved', 1),
(9, DATE_SUB(CURDATE(), INTERVAL 7 DAY), CURDATE(), 2450.00, 46.00, 720.00, 200.00, 0.00, 150.00, 5520.00, 'draft', NULL);

-- ============================================================================
-- SEED DATA: Shifts & Cash Counts
-- ============================================================================
INSERT INTO shifts (id, user_id, branch_id, shift_date, start_time, end_time, status, opening_cash, total_cash_sales, total_card_sales, total_gcash_sales, total_bank_sales, total_refunds, total_voids, expected_cash, actual_cash, cash_variance, variance_reason, approved_by, approved_at, notes) VALUES
(1, 16, 1, DATE_SUB(CURDATE(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 28 HOUR), DATE_SUB(NOW(), INTERVAL 19 HOUR), 'approved', 5000.00, 24500.00, 18200.00, 15400.00, 8500.00, 500.00, 850.00, 29000.00, 29000.00, 0.00, 'Balanced register', 1, DATE_SUB(NOW(), INTERVAL 19 HOUR), 'Shift closed without issues'),
(2, 17, 1, CURDATE(), DATE_SUB(NOW(), INTERVAL 6 HOUR), NULL, 'open', 5000.00, 13500.00, 8200.00, 9400.00, 4200.00, 0.00, 328.00, 18500.00, NULL, NULL, NULL, NULL, NULL, 'Currently active evening shift')
ON DUPLICATE KEY UPDATE status = VALUES(status), total_cash_sales = VALUES(total_cash_sales);

INSERT INTO cash_counts (shift_id, denomination, quantity, subtotal) VALUES
(1, '1000', 20, 20000.00),
(1, '500', 14, 7000.00),
(1, '100', 15, 1500.00),
(1, '50', 10, 500.00)
ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), subtotal = VALUES(subtotal);

-- ============================================================================
-- SEED DATA: Refunds & Payment Voids
-- ============================================================================
INSERT INTO refunds (order_id, original_payment_method, refund_amount, refund_method, reason, status, requested_by, approved_by, shift_id, completed_at) VALUES
(1, 'cash', 200.00, 'cash', 'Customer returned corked bottle of wine', 'completed', 16, 1, 1, DATE_SUB(NOW(), INTERVAL 4 HOUR));

INSERT INTO payment_voids (order_id, payment_method, voided_amount, reason, status, requested_by, approved_by, shift_id, completed_at) VALUES
(2, 'gcash', 500.00, 'Accidental double payment via QR scanner', 'completed', 17, 1, 2, DATE_SUB(NOW(), INTERVAL 2 HOUR));

-- ============================================================================
-- SEED DATA: Split Payments & Digital-to-Cash Conversions
-- ============================================================================
INSERT INTO split_payments (order_id, split_number, amount, payment_method, status, paid_at, processed_by) VALUES
(3, 1, 2250.00, 'debit', 'paid', DATE_SUB(NOW(), INTERVAL 1 HOUR), 16),
(3, 2, 2250.00, 'gcash', 'paid', DATE_SUB(NOW(), INTERVAL 1 HOUR), 16);

INSERT INTO payment_conversions (branch_id, shift_id, from_method, to_method, amount, notes, converted_by) VALUES
(1, 1, 'gcash', 'cash', 5000.00, 'GCash cashed out for weekly kitchen petty cash & pasahod', 'Toyskie'),
(1, 2, 'bank', 'cash', 8000.00, 'BPI Online transfer converted to cash for beverage supplier payment', 'Romgel');

-- ============================================================================
-- SEED DATA: Charge (Utang/Credit) & Table Transfers
-- ============================================================================
INSERT INTO charge_transactions (branch_id, order_ids, customer_name, amount, status, charged_by, paid_by, notes) VALUES
(1, '1', 'Boss Martin (Owner Guest Account)', 3500.00, 'pending', 'Toyskie', NULL, 'VIP Guest table hosting'),
(1, '2', 'Senator Marco (Regina Group)', 8400.00, 'paid', 'Romgel', 'Angelo Val Morante', 'Settled via direct corporate bank check');

INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason) VALUES
(4, 'L5', 'L2', 'move', 8, 'Guests wanted a table closer to the live band stage'),
(5, 'C8', 'C1', 'move', 10, 'VIP group requested bigger booth corner');

-- ============================================================================
-- SEED DATA: Attendance & Audit Logs
-- ============================================================================
INSERT INTO attendance (user_id, work_date, time_in, time_out, break_minutes, notes) VALUES
(8, CURDATE(), DATE_SUB(NOW(), INTERVAL 6 HOUR), NULL, 30, 'On time'),
(9, CURDATE(), DATE_SUB(NOW(), INTERVAL 6 HOUR), NULL, 30, 'On time'),
(16, CURDATE(), DATE_SUB(NOW(), INTERVAL 7 HOUR), NULL, 45, 'Cashier Opening Shift'),
(18, CURDATE(), DATE_SUB(NOW(), INTERVAL 5 HOUR), NULL, 15, 'Model shift active')
ON DUPLICATE KEY UPDATE time_in = VALUES(time_in);

INSERT INTO audit_logs (user_id, employee_id, user_name, role_name, action, entity_type, entity_id, details, ip_address, branch_id) VALUES
(1, 'MGR001', 'Angelo Val Morante', 'Administrator', 'LOGIN', 'user', '1', '{"status":"success"}', '127.0.0.1', 1),
(16, 'BAR001', 'Toyskie', 'Operations Staff', 'OPEN_SHIFT', 'shift', '2', '{"opening_cash":5000}', '127.0.0.1', 1),
(8, 'WTR001', 'Christian', 'Staff', 'CREATE_ORDER', 'order', '4', '{"table_id":"L2","items":3}', '192.168.1.50', 1),
(5, 'GL', 'Len Gabriel Liwanag (GL)', 'Administrator', 'APPROVE_VOID', 'order_item', '6', '{"reason":"Mistakenly added duplicate LD item"}', '192.168.1.10', 1);

-- ============================================================================
-- SEED DATA: Receipt Snapshots & Migrations Tracking
-- ============================================================================
INSERT INTO receipt_snapshots (branch_id, snapshot_type, order_id, table_id, session_id, payment_method, receipt_json, created_by) VALUES
(1, 'official_receipt', 1, 'L1', 1, 'cash', '{"orderNumber":"20260731-0001","tableId":"L1","subtotal":1339.29,"tax":160.71,"total":1500.00,"cashier":"Toyskie","items":[{"name":"Porcini and Truffle Pasta","qty":1,"price":448.00},{"name":"Garlic Butter Shrimp","qty":1,"price":368.00},{"name":"SML/SMB/SMA Bucket","qty":1,"price":598.00}]}', 16),
(1, 'running_bill', 4, 'L2', 4, NULL, '{"orderNumber":"20260731-0004","tableId":"L2","subtotal":1650.00,"tax":198.00,"total":1848.00,"waiter":"Christian","items":[{"name":"Grilled Wagyu Cubes","qty":2,"price":876.00},{"name":"RH/Mule Bucket","qty":1,"price":720.00},{"name":"Soda (Carafe)","qty":1,"price":250.00}]}', 8);

INSERT IGNORE INTO schema_migrations (migration_name) VALUES
('initial_schema'),
('add_sub_category_to_products'),
('order_void_and_per_item_void'),
('table_sessions_migration'),
('comprehensive_seed_data_v1');

-- ============================================================================
-- SETUP COMPLETE! - Rabbit Alley Garden Bar & Bistro POS
-- ============================================================================
-- 
-- Staff Accounts (all default passwords: "password"):
--
-- MANAGERS / ADMIN (Can Authorize Voids, Discounts & Reports):
--   MGR001 (Gelo)  - Angelo Val Morante - General Manager
--   MGR002 (Jedd)  - Jedd Kris Paul Patio - Officer in Charge
--   MGR003 (Gab)   - Len Gabriel Liwanag - Manager
--   MGR004 (Monk)  - Martin Tolentino - Owner
--   GL             - Len Gabriel Liwanag (GL Shortcut)
--   ADMIN          - System Administrator
--   MGR            - Default Manager Account
--
-- WAITERS:
--   WTR001 - Christian
--   WTR002 - Jhovi
--   WTR003 - Keith
--   WTR004 - Marlon
--
-- WAITRESSES:
--   WTS001 - Nikka
--   WTS002 - Yuna
--   WTS003 - Kath
--   WTS004 - Joy
--
-- BARTENDERS / CASHIERS:
--   BAR001 - Toyskie
--   BAR002 - Romgel
--
-- MODELS / LADIES (LD hostesses, selectable in POS Ladies Drink):
--   MDL001 - Angelica Santos  (Angel)
--   MDL002 - Bianca Reyes     (Bianca)
--   MDL003 - Clarisse Dela Cruz (Cla)
--   MDL004 - Diana Villanueva (Diana)
--   MDL005 - Elena Cruz       (Elena)
-- ============================================================================

