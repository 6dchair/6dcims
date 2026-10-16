from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, Integer, String

from database import Base


class Material(Base):
    __tablename__ = "materials"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(String, nullable=False)
    category = Column(String, nullable=False)

    quantity = Column(Float, default=0)
    unit = Column(String, nullable=False)

    minimum_stock = Column(Float, default=0)

    borrowable = Column(Boolean, default=True)

    location = Column(String, nullable=True)

    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )

    material_type = Column(
        String,
        default="reusable",
        nullable=False
    )

    # Values of user-defined columns, e.g. {"custom:abc": "Acme Corp"}
    custom_data = Column(JSON, nullable=True)

    table_id = Column(Integer, nullable=True)

class Borrowing(Base):
    __tablename__ = "borrowings"

    id = Column(Integer, primary_key=True, index=True)

    material_id = Column(Integer, nullable=False)
    borrower_name = Column(String, nullable=False)

    quantity = Column(Float, nullable=False)

    returned_quantity = Column(
        Float,
        default=0,
        nullable=False
    )

    borrowed_at = Column(
        DateTime,
        default=datetime.utcnow
    )

    due_date = Column(DateTime, nullable=False)

    returned_at = Column(DateTime, nullable=True)

    status = Column(
        String,
        default="active"
    )

    # Admin note, e.g. "Borrower B will return the rest tomorrow"
    remark = Column(String, nullable=True)

class MaterialIssue(Base):
    __tablename__ = "material_issues"

    id = Column(Integer, primary_key=True, index=True)

    material_id = Column(Integer, nullable=False)

    issued_to = Column(String, nullable=False)

    quantity = Column(Float, nullable=False)

    project = Column(String, nullable=True)

    purpose = Column(String, nullable=True)

    issued_at = Column(
        DateTime,
        default=datetime.utcnow
    )


class TransactionAttachment(Base):
    __tablename__ = "transaction_attachments"

    id = Column(Integer, primary_key=True, index=True)

    transaction_type = Column(String, nullable=False)  # "borrowing" | "issue"
    transaction_id = Column(Integer, nullable=False)

    original_filename = Column(String, nullable=False)
    stored_filename = Column(String, nullable=False)
    content_type = Column(String, nullable=False)
    file_path = Column(String, nullable=False)

    uploaded_at = Column(
        DateTime,
        default=datetime.utcnow
    )


class InventoryTable(Base):
    __tablename__ = "inventory_tables"

    id = Column(Integer, primary_key=True, index=True)

    name = Column(String, nullable=False)

    # "consumable" (used up) or "reusable" (can be borrowed)
    kind = Column(String, nullable=False, default="consumable")

    # Column layout chosen by the user (list of dicts), None = defaults
    columns = Column(JSON, nullable=True)

    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )

class AppSetting(Base):
    """Simple key/value store for app-wide settings (e.g. system name)."""
    __tablename__ = "app_settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)