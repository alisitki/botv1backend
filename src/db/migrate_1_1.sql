-- FAZ 1.1 Migration: Add peak_price and current_tp_price columns
-- Run this after initial migration

-- Add new columns if they don't exist
-- SQLite doesn't have IF NOT EXISTS for ALTER TABLE, so we handle errors

-- Rename trailing_high to peak_price (we'll handle this in code by using alias)
-- Add current_tp_price column
-- Add fee column to trades

-- Note: We'll handle column renames in the response layer since SQLite 
-- doesn't support easy column renames. The DB will keep old names.

-- This file documents the schema changes for FAZ 1.1
-- Actual changes are handled in code (response transformation)
