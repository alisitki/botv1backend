#!/bin/bash
# FAZ 6: SQLite Database Backup Script with Retention

set -e

# Configuration
DB_PATH="./data/trading.db"
BACKUP_DIR="./backups"
RETENTION_DAYS=7

# Create backup directory if not exists
mkdir -p "$BACKUP_DIR"

# Generate backup filename with timestamp
TIMESTAMP=$(date +"%Y%m%d-%H%M")
BACKUP_FILE="$BACKUP_DIR/trading-$TIMESTAMP.db"
BACKUP_GZ="$BACKUP_FILE.gz"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    echo "❌ Database not found: $DB_PATH"
    exit 1
fi

echo "📦 Starting backup..."
echo "   Source: $DB_PATH"
echo "   Target: $BACKUP_GZ"

# Create backup using sqlite3 .backup command (or cp for simpler approach)
# Using cp with memory flush via sqlite3 pragma if available
if command -v sqlite3 &> /dev/null; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
    # Fallback to simple copy (ensure WAL is flushed)
    cp "$DB_PATH" "$BACKUP_FILE"
fi

# Compress backup
gzip "$BACKUP_FILE"

# Calculate size
SIZE=$(du -h "$BACKUP_GZ" | cut -f1)
echo "✅ Backup created: $BACKUP_GZ ($SIZE)"

# Apply retention policy
echo ""
echo "🗑️  Applying retention policy ($RETENTION_DAYS days)..."
find "$BACKUP_DIR" -name "trading-*.db.gz" -mtime +$RETENTION_DAYS -delete -print | while read f; do
    echo "   Deleted: $f"
done

# List current backups
echo ""
echo "📁 Current backups:"
ls -lh "$BACKUP_DIR"/*.gz 2>/dev/null || echo "   No backups found"

echo ""
echo "✅ Backup complete!"
