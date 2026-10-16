from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    UploadFile,
    File
)
from pathlib import Path
from uuid import uuid4
import io
import json
import re
import shutil
import zipfile
from sqlalchemy.orm import Session

from fastapi.responses import FileResponse, Response

from database import Base, SessionLocal, engine, get_db
from schemas import (
    MaterialCreate,
    TableCreate,
    TableUpdate,
    TableResponse,
    MaterialResponse,
    BorrowingCreate,
    BorrowingResponse,
    BorrowingReturnCreate,
    BorrowingUpdate,
    MaterialIssueUpdate,
    MaterialIssueCreate,
    MaterialIssueResponse,
    AttachmentResponse,
    SettingsUpdate,
    SettingsResponse,
)
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from datetime import datetime
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, text

import models


UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

Base.metadata.create_all(bind=engine)

# Lightweight migration: add the custom_data column to existing databases
with engine.begin() as connection:
    existing_columns = [
        row[1]
        for row in connection.execute(
            text("PRAGMA table_info(materials)")
        )
    ]

    if "custom_data" not in existing_columns:
        connection.execute(
            text("ALTER TABLE materials ADD COLUMN custom_data JSON")
        )

    if "table_id" not in existing_columns:
        connection.execute(
            text("ALTER TABLE materials ADD COLUMN table_id INTEGER")
        )

    # Add the remark column to existing borrowings tables
    borrowing_columns = [
        row[1]
        for row in connection.execute(
            text("PRAGMA table_info(borrowings)")
        )
    ]

    if "remark" not in borrowing_columns:
        connection.execute(
            text("ALTER TABLE borrowings ADD COLUMN remark VARCHAR")
        )


def migrate_legacy_materials():
    """Items created before tables existed are moved into two tables
    (one per material type) so nothing is lost. A brand-new database
    has no such items, so it starts completely empty."""
    db = SessionLocal()

    try:
        orphans = db.query(models.Material).filter(
            models.Material.table_id.is_(None)
        ).all()

        if not orphans:
            return

        names = {
            "consumable": "Consumable Materials",
            "reusable": "Borrowable Materials",
        }
        table_ids = {}

        for item in orphans:
            kind = (
                item.material_type
                if item.material_type in names
                else "reusable"
            )

            if kind not in table_ids:
                table = models.InventoryTable(
                    name=names[kind],
                    kind=kind
                )
                db.add(table)
                db.flush()
                table_ids[kind] = table.id

            item.table_id = table_ids[kind]

        db.commit()
    finally:
        db.close()


migrate_legacy_materials()

app = FastAPI(
    title="Construction Warehouse API"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost",
        "https://localhost",
        "capacitor://localhost",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {
        "message": "Construction Warehouse API is running"
    }


@app.post(
    "/materials",
    response_model=MaterialResponse
)
def create_material(
    material: MaterialCreate,
    db: Session = Depends(get_db)
):
    table = db.query(models.InventoryTable).filter(
        models.InventoryTable.id == material.table_id
    ).first()

    if not table:
        raise HTTPException(
            status_code=400,
            detail="Choose a table for this item"
        )

    new_material = models.Material(
        name=material.name,
        category=material.category,
        quantity=material.quantity,
        unit=material.unit,
        minimum_stock=material.minimum_stock,
        borrowable=(table.kind == "reusable"),
        location=material.location,
        material_type=table.kind,
        table_id=table.id,
        custom_data=material.custom_data or {}
    )

    db.add(new_material)
    db.commit()
    db.refresh(new_material)

    return new_material

def material_has_history(db: Session, material_id: int) -> bool:
    has_borrowings = db.query(models.Borrowing).filter(
        models.Borrowing.material_id == material_id
    ).first() is not None

    has_issues = db.query(models.MaterialIssue).filter(
        models.MaterialIssue.material_id == material_id
    ).first() is not None

    return has_borrowings or has_issues


@app.put(
    "/materials/{material_id}",
    response_model=MaterialResponse
)
def update_material(
    material_id: int,
    data: MaterialCreate,
    db: Session = Depends(get_db)
):
    material = db.query(models.Material).filter(
        models.Material.id == material_id
    ).first()

    if not material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    if data.quantity < 0 or data.minimum_stock < 0:
        raise HTTPException(
            status_code=400,
            detail="Quantity and minimum stock cannot be negative"
        )

    material.name = data.name
    material.category = data.category
    material.quantity = data.quantity
    material.unit = data.unit
    material.minimum_stock = data.minimum_stock
    material.location = data.location
    material.custom_data = data.custom_data or {}

    db.commit()
    db.refresh(material)

    return material


@app.delete(
    "/materials/{material_id}",
    status_code=204
)
def delete_material(
    material_id: int,
    db: Session = Depends(get_db)
):
    material = db.query(models.Material).filter(
        models.Material.id == material_id
    ).first()

    if not material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    if material_has_history(db, material_id):
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot delete this material because it has "
                "borrowing or consumption records"
            )
        )

    db.delete(material)
    db.commit()


@app.get(
    "/issues",
    response_model=list[MaterialIssueResponse]
)
def get_material_issues(
    db: Session = Depends(get_db)
):
    return db.query(models.MaterialIssue).order_by(
        models.MaterialIssue.issued_at.desc()
    ).all()


@app.get(
    "/materials",
    response_model=list[MaterialResponse]
)
def get_materials(
    db: Session = Depends(get_db)
):
    return db.query(models.Material).all()


@app.post(
    "/borrowings",
    response_model=BorrowingResponse
)
def create_borrowing(
    borrowing: BorrowingCreate,
    db: Session = Depends(get_db)
):
    material = db.query(models.Material).filter(
        models.Material.id == borrowing.material_id
    ).first()

    if not material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    if not material.borrowable:
        raise HTTPException(
            status_code=400,
            detail="This material cannot be borrowed"
        )

    if borrowing.quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail="Quantity must be greater than zero"
        )

    if borrowing.quantity > material.quantity:
        raise HTTPException(
            status_code=400,
            detail="Not enough stock available"
        )

    material.quantity -= borrowing.quantity

    new_borrowing = models.Borrowing(
        material_id=borrowing.material_id,
        borrower_name=borrowing.borrower_name,
        quantity=borrowing.quantity,
        due_date=borrowing.due_date
    )

    db.add(new_borrowing)
    db.commit()
    db.refresh(new_borrowing)

    return new_borrowing


@app.post(
    "/borrowings/{borrowing_id}/return",
    response_model=BorrowingResponse
)
def return_borrowing(
    borrowing_id: int,
    return_data: BorrowingReturnCreate,
    db: Session = Depends(get_db)
):
    borrowing = db.query(models.Borrowing).filter(
        models.Borrowing.id == borrowing_id
    ).first()

    if not borrowing:
        raise HTTPException(
            status_code=404,
            detail="Borrowing record not found"
        )

    if borrowing.status == "returned":
        raise HTTPException(
            status_code=400,
            detail="This borrowing has already been fully returned"
        )

    if return_data.quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail="Return quantity must be greater than zero"
        )

    remaining_quantity = (
        borrowing.quantity
        - borrowing.returned_quantity
    )

    if return_data.quantity > remaining_quantity:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Cannot return {format_qty(return_data.quantity)}. "
                f"Only {format_qty(remaining_quantity, 'item')} "
                f"{'is' if remaining_quantity == 1 else 'are'} still outstanding."
            )
        )

    material = db.query(models.Material).filter(
        models.Material.id == borrowing.material_id
    ).first()

    if not material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    # Restore only the quantity actually returned
    material.quantity += return_data.quantity

    # Record the returned quantity
    borrowing.returned_quantity += return_data.quantity

    # Optional admin note (blank clears it)
    if return_data.remark is not None:
        borrowing.remark = return_data.remark.strip() or None

    # Check whether everything has been returned
    if borrowing.returned_quantity >= borrowing.quantity:
        borrowing.returned_at = datetime.utcnow()
        borrowing.status = "returned"
    else:
        borrowing.status = "partially_returned"

    db.commit()
    db.refresh(borrowing)

    return borrowing

def to_naive_utc(value: datetime) -> datetime:
    """The database stores naive UTC datetimes."""
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    return value


@app.put(
    "/borrowings/{borrowing_id}",
    response_model=BorrowingResponse
)
def update_borrowing(
    borrowing_id: int,
    data: BorrowingUpdate,
    db: Session = Depends(get_db)
):
    borrowing = db.query(models.Borrowing).filter(
        models.Borrowing.id == borrowing_id
    ).first()

    if not borrowing:
        raise HTTPException(
            status_code=404,
            detail="Borrowing record not found"
        )

    new_name = borrowing.borrower_name

    if data.borrower_name is not None:
        new_name = data.borrower_name.strip()

        if not new_name:
            raise HTTPException(
                status_code=400,
                detail="Borrower name is required"
            )

    new_material_id = (
        data.material_id
        if data.material_id is not None
        else borrowing.material_id
    )
    new_quantity = (
        data.quantity
        if data.quantity is not None
        else borrowing.quantity
    )
    new_returned = (
        data.returned_quantity
        if data.returned_quantity is not None
        else borrowing.returned_quantity
    )

    if new_quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail="Quantity must be greater than zero"
        )

    if new_returned < 0:
        raise HTTPException(
            status_code=400,
            detail="Returned quantity cannot be negative"
        )

    if new_returned > new_quantity:
        raise HTTPException(
            status_code=400,
            detail="Returned quantity cannot be more than the quantity"
        )

    old_material = db.query(models.Material).filter(
        models.Material.id == borrowing.material_id
    ).first()

    new_material = db.query(models.Material).filter(
        models.Material.id == new_material_id
    ).first()

    if not new_material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    material_changed = new_material_id != borrowing.material_id

    if material_changed and not new_material.borrowable:
        raise HTTPException(
            status_code=400,
            detail="This material cannot be borrowed"
        )

    # Stock taken out of the warehouse = borrowed - returned
    old_out = borrowing.quantity - borrowing.returned_quantity
    new_out = new_quantity - new_returned

    available = new_material.quantity + (
        0 if material_changed else old_out
    )

    if new_out > available:
        raise HTTPException(
            status_code=400,
            detail="Not enough stock available for those changes"
        )

    if old_material:
        old_material.quantity += old_out

    new_material.quantity -= new_out

    borrowing.material_id = new_material_id
    borrowing.borrower_name = new_name
    borrowing.quantity = new_quantity
    borrowing.returned_quantity = new_returned

    if data.due_date is not None:
        borrowing.due_date = to_naive_utc(data.due_date)

    if data.remark is not None:
        borrowing.remark = data.remark.strip() or None

    if new_returned >= new_quantity:
        borrowing.status = "returned"

        if borrowing.returned_at is None:
            borrowing.returned_at = datetime.utcnow()
    else:
        borrowing.returned_at = None
        borrowing.status = (
            "partially_returned" if new_returned > 0 else "active"
        )

    db.commit()
    db.refresh(borrowing)

    return borrowing


@app.put(
    "/issues/{issue_id}",
    response_model=MaterialIssueResponse
)
def update_material_issue(
    issue_id: int,
    data: MaterialIssueUpdate,
    db: Session = Depends(get_db)
):
    issue = db.query(models.MaterialIssue).filter(
        models.MaterialIssue.id == issue_id
    ).first()

    if not issue:
        raise HTTPException(
            status_code=404,
            detail="Consumption record not found"
        )

    new_issued_to = issue.issued_to

    if data.issued_to is not None:
        new_issued_to = data.issued_to.strip()

        if not new_issued_to:
            raise HTTPException(
                status_code=400,
                detail="'Issued to' is required"
            )

    new_material_id = (
        data.material_id
        if data.material_id is not None
        else issue.material_id
    )
    new_quantity = (
        data.quantity
        if data.quantity is not None
        else issue.quantity
    )

    if new_quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail="Quantity must be greater than zero"
        )

    old_material = db.query(models.Material).filter(
        models.Material.id == issue.material_id
    ).first()

    new_material = db.query(models.Material).filter(
        models.Material.id == new_material_id
    ).first()

    if not new_material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    material_changed = new_material_id != issue.material_id

    if material_changed and new_material.material_type != "consumable":
        raise HTTPException(
            status_code=400,
            detail="Only consumable materials can be issued"
        )

    available = new_material.quantity + (
        0 if material_changed else issue.quantity
    )

    if new_quantity > available:
        raise HTTPException(
            status_code=400,
            detail="Not enough stock available for those changes"
        )

    if old_material:
        old_material.quantity += issue.quantity

    new_material.quantity -= new_quantity

    issue.material_id = new_material_id
    issue.issued_to = new_issued_to
    issue.quantity = new_quantity

    if data.project is not None:
        issue.project = data.project.strip() or None

    if data.purpose is not None:
        issue.purpose = data.purpose.strip() or None

    if data.issued_at is not None:
        issue.issued_at = to_naive_utc(data.issued_at)

    db.commit()
    db.refresh(issue)

    return issue


@app.post(
    "/issues",
    response_model=MaterialIssueResponse
)
def create_material_issue(
    issue: MaterialIssueCreate,
    db: Session = Depends(get_db)
):
    material = db.query(models.Material).filter(
        models.Material.id == issue.material_id
    ).first()

    if not material:
        raise HTTPException(
            status_code=404,
            detail="Material not found"
        )

    if material.material_type != "consumable":
        raise HTTPException(
            status_code=400,
            detail="Only consumable materials can be issued"
        )

    if issue.quantity <= 0:
        raise HTTPException(
            status_code=400,
            detail="Quantity must be greater than zero"
        )

    if issue.quantity > material.quantity:
        raise HTTPException(
            status_code=400,
            detail="Not enough stock available"
        )

    material.quantity -= issue.quantity

    new_issue = models.MaterialIssue(
        material_id=issue.material_id,
        issued_to=issue.issued_to,
        quantity=issue.quantity,
        project=issue.project,
        purpose=issue.purpose
    )

    db.add(new_issue)
    db.commit()
    db.refresh(new_issue)

    return new_issue


# for plural units
def plural(count, word):
    """1 -> singular, anything else -> plural (kg stays kg)."""
    if count == 1 or word.lower() in ("kg", "g", "mg", "m", "cm", "mm", "ft", "lb"):
        return word
    if word.endswith(("s", "x", "z", "ch", "sh")):
        return word + "es"
    if len(word) > 1 and word.endswith("y") and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def format_qty(count, unit=""):
    """5.0 -> '5 pieces', 1.0 -> '1 piece', 3 with no unit -> '3'."""
    number = int(count) if float(count).is_integer() else count

    if not unit:
        return str(number)

    return f"{number} {plural(count, unit)}"


@app.get("/alerts")
def get_alerts(
    db: Session = Depends(get_db)
):
    alerts = []

    now = datetime.utcnow()
    today = now.date()
    tomorrow = today + timedelta(days=1)

    # --------------------------------------------------
    # Borrowing alerts
    # --------------------------------------------------

    active_borrowings = db.query(models.Borrowing).filter(
        models.Borrowing.status == "active"
    ).all()

    for borrowing in active_borrowings:

        material = db.query(models.Material).filter(
            models.Material.id == borrowing.material_id
        ).first()

        if not material:
            continue

        due_date = borrowing.due_date.date()

        # Overdue
        if due_date < today:
            days_overdue = (today - due_date).days

            alerts.append({
                "type": "overdue",
                "severity": "critical",
                "message": (
                    f"{material.name} borrowed by "
                    f"{borrowing.borrower_name} is "
                    f"{days_overdue} {plural(days_overdue, 'day')} overdue"
                ),
                "borrowing_id": borrowing.id,
                "material_id": material.id
            })

        # Due today
        elif due_date == today:

            alerts.append({
                "type": "due_today",
                "severity": "warning",
                "message": (
                    f"{material.name} borrowed by "
                    f"{borrowing.borrower_name} is due today"
                ),
                "borrowing_id": borrowing.id,
                "material_id": material.id
            })

        # Due tomorrow
        elif due_date == tomorrow:

            alerts.append({
                "type": "due_soon",
                "severity": "info",
                "message": (
                    f"{material.name} borrowed by "
                    f"{borrowing.borrower_name} is due tomorrow"
                ),
                "borrowing_id": borrowing.id,
                "material_id": material.id
            })

    # --------------------------------------------------
    # Inventory alerts
    # --------------------------------------------------

    materials = db.query(models.Material).all()

    for material in materials:

        # Out of stock
        if material.quantity <= 0:

            alerts.append({
                "type": "out_of_stock",
                "severity": "critical",
                "message": (
                    f"{material.name} is out of stock"
                ),
                "material_id": material.id
            })

        # Low stock
        elif material.quantity <= material.minimum_stock:

            alerts.append({
                "type": "low_stock",
                "severity": "warning",
                "message": (
                    f"{material.name} is low on stock "
                    f"({format_qty(material.quantity, material.unit)} remaining)"
                ),
                "material_id": material.id
            })

    return alerts


@app.get(
    "/borrowings",
    response_model=list[BorrowingResponse]
)
def get_borrowings(
    db: Session = Depends(get_db)
):
    return db.query(models.Borrowing).order_by(
        models.Borrowing.id.desc()
    ).all()

@app.post(
    "/attachments/{transaction_type}/{transaction_id}",
    response_model=AttachmentResponse
)
async def upload_attachment(
    transaction_type: str,
    transaction_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    # --------------------------------------------------
    # Validate transaction type
    # --------------------------------------------------

    if transaction_type not in ["borrowing", "issue"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid transaction type"
        )

    # --------------------------------------------------
    # Verify transaction exists
    # --------------------------------------------------

    if transaction_type == "borrowing":

        transaction = db.query(
            models.Borrowing
        ).filter(
            models.Borrowing.id == transaction_id
        ).first()

        if not transaction:
            raise HTTPException(
                status_code=404,
                detail="Borrowing record not found"
            )

    else:

        transaction = db.query(
            models.MaterialIssue
        ).filter(
            models.MaterialIssue.id == transaction_id
        ).first()

        if not transaction:
            raise HTTPException(
                status_code=404,
                detail="Consumption record not found"
            )

    # --------------------------------------------------
    # Validate file type
    # --------------------------------------------------

    allowed_types = {
        # Images
        "image/jpeg",
        "image/png",
        "image/webp",

        # Documents
        "application/pdf",
        "text/plain",

        # Common Office documents
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

        # Videos
        "video/mp4",
        "video/webm",
        "video/quicktime",
    }

    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail="Unsupported attachment type"
        )

    # --------------------------------------------------
    # Generate safe filename
    # --------------------------------------------------

    original_filename = file.filename or "attachment"

    extension = Path(
        original_filename
    ).suffix.lower()

    stored_filename = (
        f"{transaction_type}_"
        f"{transaction_id}_"
        f"{uuid4().hex}"
        f"{extension}"
    )

    file_path = UPLOAD_DIR / stored_filename

    # --------------------------------------------------
    # Save file
    # --------------------------------------------------

    with file_path.open("wb") as buffer:
        shutil.copyfileobj(
            file.file,
            buffer
        )

    # --------------------------------------------------
    # Save database record
    # --------------------------------------------------

    attachment = models.TransactionAttachment(
        transaction_type=transaction_type,
        transaction_id=transaction_id,
        original_filename=original_filename,
        stored_filename=stored_filename,
        content_type=file.content_type,
        file_path=str(file_path)
    )

    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    return attachment

@app.get(
    "/attachments/{transaction_type}/{transaction_id}",
    response_model=list[AttachmentResponse]
)
def get_attachments(
    transaction_type: str,
    transaction_id: int,
    db: Session = Depends(get_db)
):
    if transaction_type not in ["borrowing", "issue"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid transaction type"
        )

    return db.query(
        models.TransactionAttachment
    ).filter(
        models.TransactionAttachment.transaction_type
        == transaction_type,
        models.TransactionAttachment.transaction_id
        == transaction_id
    ).order_by(
        models.TransactionAttachment.uploaded_at.desc()
    ).all()


@app.get(
    "/attachment-files/{attachment_id}"
)
def get_attachment_file(
    attachment_id: int,
    db: Session = Depends(get_db)
):
    attachment = db.query(
        models.TransactionAttachment
    ).filter(
        models.TransactionAttachment.id == attachment_id
    ).first()

    if not attachment:
        raise HTTPException(
            status_code=404,
            detail="Attachment not found"
        )

    file_path = Path(
        attachment.file_path
    )

    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Attachment file not found"
        )

    # "inline" lets the browser/device open the file in a viewer
    # (PDF reader, photo viewer, video player) instead of downloading it
    return FileResponse(
        path=file_path,
        media_type=attachment.content_type,
        filename=attachment.original_filename,
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff"}
    )


@app.delete(
    "/attachment-files/{attachment_id}",
    status_code=204
)
def delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db)
):
    attachment = db.query(
        models.TransactionAttachment
    ).filter(
        models.TransactionAttachment.id == attachment_id
    ).first()

    if not attachment:
        raise HTTPException(
            status_code=404,
            detail="Attachment not found"
        )

    file_path = Path(attachment.file_path)

    db.delete(attachment)
    db.commit()

    # Remove the stored file too (ignore if it is already gone)
    try:
        file_path.unlink(missing_ok=True)
    except OSError:
        pass


# --------------------------------------------------
# Settings (system name, admin name, accent color)
# --------------------------------------------------

DEFAULT_ACCENT = "#1f47c8"
MAX_NAME_LENGTH = 60

SETTING_DEFAULTS = {
    "system_name": "Construction Warehouse",
    "admin_name": "",
    "accent_color": DEFAULT_ACCENT,
}


def read_settings(db: Session) -> dict:
    result = dict(SETTING_DEFAULTS)

    for row in db.query(models.AppSetting).all():
        if row.key in result:
            result[row.key] = row.value

    return result


def write_setting(db: Session, key: str, value: str):
    setting = db.query(models.AppSetting).filter(
        models.AppSetting.key == key
    ).first()

    if setting:
        setting.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))


@app.get(
    "/settings",
    response_model=SettingsResponse
)
def get_settings(
    db: Session = Depends(get_db)
):
    return read_settings(db)


@app.put(
    "/settings",
    response_model=SettingsResponse
)
def update_settings(
    data: SettingsUpdate,
    db: Session = Depends(get_db)
):
    if data.system_name is not None:
        name = " ".join(data.system_name.split())

        if not name:
            raise HTTPException(
                status_code=400,
                detail="System name is required"
            )

        if len(name) > MAX_NAME_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"System name must be at most "
                    f"{MAX_NAME_LENGTH} characters"
                )
            )

        write_setting(db, "system_name", name)

    if data.admin_name is not None:
        admin = " ".join(data.admin_name.split())

        if len(admin) > MAX_NAME_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Admin name must be at most "
                    f"{MAX_NAME_LENGTH} characters"
                )
            )

        # An empty value removes the admin name
        write_setting(db, "admin_name", admin)

    if data.accent_color is not None:
        color = data.accent_color.strip().lower()

        if not re.fullmatch(r"#[0-9a-f]{6}", color):
            raise HTTPException(
                status_code=400,
                detail="Accent color must look like #1f47c8"
            )

        write_setting(db, "accent_color", color)

    db.commit()

    return read_settings(db)


# --------------------------------------------------
# Export / import (full backup)
# --------------------------------------------------

EXPORT_APP = "construction-warehouse"
EXPORT_VERSION = 1
DATA_FILE = "warehouse-data.json"
MAX_IMPORT_BYTES = 500 * 1024 * 1024

EXPORT_MODELS = {
    "inventory_tables": models.InventoryTable,
    "materials": models.Material,
    "borrowings": models.Borrowing,
    "material_issues": models.MaterialIssue,
    "transaction_attachments": models.TransactionAttachment,
    "app_settings": models.AppSetting,
}


def serialize_row(obj) -> dict:
    data = {}

    for column in obj.__table__.columns:
        value = getattr(obj, column.key)

        if isinstance(value, datetime):
            value = value.isoformat()

        data[column.key] = value

    return data


def build_row(model, data: dict):
    if not isinstance(data, dict):
        raise ValueError("Each record must be an object")

    values = {}

    for column in model.__table__.columns:
        if column.key not in data:
            continue

        value = data[column.key]

        if value is not None and isinstance(column.type, DateTime):
            value = to_naive_utc(datetime.fromisoformat(value))

        values[column.key] = value

    return model(**values)


@app.get("/export")
def export_data(
    db: Session = Depends(get_db)
):
    payload = {
        "app": EXPORT_APP,
        "version": EXPORT_VERSION,
        "exported_at": datetime.utcnow().isoformat(),
        "data": {
            name: [
                serialize_row(row)
                for row in db.query(model).all()
            ]
            for name, model in EXPORT_MODELS.items()
        },
    }

    buffer = io.BytesIO()

    with zipfile.ZipFile(
        buffer, "w", zipfile.ZIP_DEFLATED
    ) as archive:
        archive.writestr(DATA_FILE, json.dumps(payload, indent=2))

        for attachment in db.query(
            models.TransactionAttachment
        ).all():
            path = UPLOAD_DIR / Path(attachment.stored_filename).name

            if path.exists():
                archive.write(path, f"uploads/{path.name}")

    filename = (
        f"warehouse-backup-{datetime.utcnow():%Y-%m-%d}.zip"
    )

    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


@app.post("/import")
async def import_data(
    file: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    raw = await file.read()

    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="That file is too large to import"
        )

    invalid = HTTPException(
        status_code=400,
        detail="This is not a valid warehouse backup file"
    )

    # ---------- read the file ----------
    proof_files: dict[str, bytes] = {}

    try:
        if zipfile.is_zipfile(io.BytesIO(raw)):
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                if DATA_FILE not in archive.namelist():
                    raise invalid

                total = sum(i.file_size for i in archive.infolist())

                if total > MAX_IMPORT_BYTES:
                    raise invalid

                payload = json.loads(archive.read(DATA_FILE))

                for info in archive.infolist():
                    if (
                        info.filename.startswith("uploads/")
                        and not info.is_dir()
                    ):
                        name = Path(info.filename).name

                        if name:
                            proof_files[name] = archive.read(info)
        else:
            payload = json.loads(raw.decode("utf-8"))
    except HTTPException:
        raise
    except (ValueError, zipfile.BadZipFile, UnicodeDecodeError):
        raise invalid

    if (
        not isinstance(payload, dict)
        or payload.get("app") != EXPORT_APP
        or not isinstance(payload.get("data"), dict)
    ):
        raise invalid

    if payload.get("version", 0) > EXPORT_VERSION:
        raise HTTPException(
            status_code=400,
            detail="This backup was made by a newer version of the app"
        )

    # ---------- build the new rows (validates everything) ----------
    try:
        new_rows = {}

        for name, model in EXPORT_MODELS.items():
            records = payload["data"].get(name, [])

            if not isinstance(records, list):
                raise invalid

            new_rows[name] = [build_row(model, r) for r in records]

        for attachment in new_rows["transaction_attachments"]:
            safe_name = Path(attachment.stored_filename).name
            attachment.stored_filename = safe_name
            attachment.file_path = str(UPLOAD_DIR / safe_name)
    except HTTPException:
        raise
    except (TypeError, ValueError, KeyError, AttributeError):
        raise invalid

    # ---------- replace the current data ----------
    old_files = [
        UPLOAD_DIR / Path(a.stored_filename).name
        for a in db.query(models.TransactionAttachment).all()
    ]

    try:
        for model in EXPORT_MODELS.values():
            db.query(model).delete()

        for rows in new_rows.values():
            db.add_all(rows)

        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Could not import this file. Nothing was changed."
        )

    # ---------- proof files ----------
    for path in old_files:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    wanted = {
        a.stored_filename for a in new_rows["transaction_attachments"]
    }

    for name, content in proof_files.items():
        if name in wanted:
            (UPLOAD_DIR / name).write_bytes(content)

    return {
        "imported": {
            name: len(rows) for name, rows in new_rows.items()
        }
    }


# --------------------------------------------------
# Tables
# --------------------------------------------------

VALID_KINDS = {"consumable", "reusable"}


@app.get(
    "/tables",
    response_model=list[TableResponse]
)
def get_tables(
    db: Session = Depends(get_db)
):
    return db.query(models.InventoryTable).order_by(
        models.InventoryTable.id
    ).all()


@app.post(
    "/tables",
    response_model=TableResponse
)
def create_table(
    data: TableCreate,
    db: Session = Depends(get_db)
):
    name = data.name.strip()

    if not name:
        raise HTTPException(
            status_code=400,
            detail="Table name is required"
        )

    if data.kind not in VALID_KINDS:
        raise HTTPException(
            status_code=400,
            detail="Table kind must be consumable or reusable"
        )

    table = models.InventoryTable(name=name, kind=data.kind)

    db.add(table)
    db.commit()
    db.refresh(table)

    return table


@app.put(
    "/tables/{table_id}",
    response_model=TableResponse
)
def update_table(
    table_id: int,
    data: TableUpdate,
    db: Session = Depends(get_db)
):
    table = db.query(models.InventoryTable).filter(
        models.InventoryTable.id == table_id
    ).first()

    if not table:
        raise HTTPException(
            status_code=404,
            detail="Table not found"
        )

    if data.name is not None:
        name = data.name.strip()

        if not name:
            raise HTTPException(
                status_code=400,
                detail="Table name is required"
            )

        table.name = name

    items = db.query(models.Material).filter(
        models.Material.table_id == table_id
    ).all()

    # Change the table kind (consumable <-> reusable)
    if data.kind is not None and data.kind != table.kind:
        if data.kind not in VALID_KINDS:
            raise HTTPException(
                status_code=400,
                detail="Table kind must be consumable or reusable"
            )

        if any(material_has_history(db, item.id) for item in items):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Cannot change the kind because some items "
                    "already have borrowing or consumption records"
                )
            )

        table.kind = data.kind

        for item in items:
            item.material_type = data.kind
            item.borrowable = (data.kind == "reusable")

    if data.columns is not None:
        # Keep only well-formed columns with a string key
        columns = [
            c for c in data.columns
            if isinstance(c, dict) and isinstance(c.get("key"), str)
        ]
        table.columns = columns

        # Remove values of deleted custom columns from every item
        valid_keys = {c["key"] for c in columns}

        for item in items:
            if not item.custom_data:
                continue

            cleaned = {
                key: value
                for key, value in item.custom_data.items()
                if not key.startswith("custom:") or key in valid_keys
            }

            if cleaned != item.custom_data:
                item.custom_data = cleaned

    db.commit()
    db.refresh(table)

    return table


@app.delete(
    "/tables/{table_id}",
    status_code=204
)
def delete_table(
    table_id: int,
    force: bool = False,
    db: Session = Depends(get_db)
):
    table = db.query(models.InventoryTable).filter(
        models.InventoryTable.id == table_id
    ).first()

    if not table:
        raise HTTPException(
            status_code=404,
            detail="Table not found"
        )

    items = db.query(models.Material).filter(
        models.Material.table_id == table_id
    ).all()

    if not force and any(
        material_has_history(db, item.id) for item in items
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot delete this table because some of its items "
                "have borrowing or consumption records"
            )
        )

    stored_files = []

    if force:
        # Also remove the history (and proof files) of every item
        for item in items:
            borrowings = db.query(models.Borrowing).filter(
                models.Borrowing.material_id == item.id
            ).all()
            issues = db.query(models.MaterialIssue).filter(
                models.MaterialIssue.material_id == item.id
            ).all()

            for kind, records in (
                ("borrowing", borrowings),
                ("issue", issues),
            ):
                for record in records:
                    attachments = db.query(
                        models.TransactionAttachment
                    ).filter(
                        models.TransactionAttachment.transaction_type
                        == kind,
                        models.TransactionAttachment.transaction_id
                        == record.id
                    ).all()

                    for attachment in attachments:
                        stored_files.append(Path(attachment.file_path))
                        db.delete(attachment)

                    db.delete(record)

    for item in items:
        db.delete(item)

    db.delete(table)
    db.commit()

    for file_path in stored_files:
        try:
            file_path.unlink(missing_ok=True)
        except OSError:
            pass