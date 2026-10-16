# from typing import Optional

# from pydantic import BaseModel

# from datetime import datetime



# class MaterialCreate(BaseModel):
#     name: str
#     category: str

#     quantity: float = 0
#     unit: str

#     minimum_stock: float = 0

#     material_type: str = "reusable"

#     borrowable: bool = True

#     location: Optional[str] = None

#     custom_data: Optional[dict[str, str]] = None

#     table_id: Optional[int] = None


# class MaterialResponse(MaterialCreate):
#     id: int

#     class Config:
#         from_attributes = True

# class BorrowingCreate(BaseModel):
#     material_id: int
#     borrower_name: str
#     quantity: float
#     due_date: datetime


# class BorrowingResponse(BaseModel):
#     id: int
#     material_id: int
#     borrower_name: str
#     quantity: float
#     returned_quantity: float

#     borrowed_at: datetime
#     due_date: datetime

#     returned_at: Optional[datetime] = None
#     status: str
#     remark: Optional[str] = None

#     class Config:
#         from_attributes = True
        
# class BorrowingReturnCreate(BaseModel):
#     quantity: float
#     remark: Optional[str] = None


# class BorrowingUpdate(BaseModel):
#     material_id: Optional[int] = None
#     borrower_name: Optional[str] = None
#     quantity: Optional[float] = None
#     returned_quantity: Optional[float] = None
#     due_date: Optional[datetime] = None
#     remark: Optional[str] = None


# class MaterialIssueUpdate(BaseModel):
#     material_id: Optional[int] = None
#     issued_to: Optional[str] = None
#     quantity: Optional[float] = None
#     project: Optional[str] = None
#     purpose: Optional[str] = None
#     issued_at: Optional[datetime] = None

# class MaterialIssueCreate(BaseModel):
#     material_id: int
#     issued_to: str
#     quantity: float
#     project: Optional[str] = None
#     purpose: Optional[str] = None


# class MaterialIssueResponse(BaseModel):
#     id: int
#     material_id: int
#     issued_to: str
#     quantity: float
#     project: Optional[str] = None
#     purpose: Optional[str] = None
#     issued_at: datetime

#     class Config:
#         from_attributes = True

# class AttachmentResponse(BaseModel):
#     id: int
#     transaction_type: str
#     transaction_id: int

#     original_filename: str
#     content_type: str

#     uploaded_at: datetime

#     class Config:
#         from_attributes = True


# class TableCreate(BaseModel):
#     name: str
#     kind: str = "consumable"


# class TableUpdate(BaseModel):
#     name: Optional[str] = None
#     kind: Optional[str] = None
#     columns: Optional[list[dict]] = None


# class TableResponse(BaseModel):
#     id: int
#     name: str
#     kind: str
#     columns: Optional[list[dict]] = None

#     class Config:
#         from_attributes = True

# class SettingsUpdate(BaseModel):
#     system_name: str


# class SettingsResponse(BaseModel):
#     system_name: str

from typing import Optional

from pydantic import BaseModel

from datetime import datetime



class MaterialCreate(BaseModel):
    name: str
    category: str

    quantity: float = 0
    unit: str

    minimum_stock: float = 0

    material_type: str = "reusable"

    borrowable: bool = True

    location: Optional[str] = None

    custom_data: Optional[dict[str, str]] = None

    table_id: Optional[int] = None


class MaterialResponse(MaterialCreate):
    id: int

    class Config:
        from_attributes = True

class BorrowingCreate(BaseModel):
    material_id: int
    borrower_name: str
    quantity: float
    due_date: datetime


class BorrowingResponse(BaseModel):
    id: int
    material_id: int
    borrower_name: str
    quantity: float
    returned_quantity: float

    borrowed_at: datetime
    due_date: datetime

    returned_at: Optional[datetime] = None
    status: str
    remark: Optional[str] = None

    class Config:
        from_attributes = True
        
class BorrowingReturnCreate(BaseModel):
    quantity: float
    remark: Optional[str] = None


class BorrowingUpdate(BaseModel):
    material_id: Optional[int] = None
    borrower_name: Optional[str] = None
    quantity: Optional[float] = None
    returned_quantity: Optional[float] = None
    due_date: Optional[datetime] = None
    remark: Optional[str] = None


class MaterialIssueUpdate(BaseModel):
    material_id: Optional[int] = None
    issued_to: Optional[str] = None
    quantity: Optional[float] = None
    project: Optional[str] = None
    purpose: Optional[str] = None
    issued_at: Optional[datetime] = None

class MaterialIssueCreate(BaseModel):
    material_id: int
    issued_to: str
    quantity: float
    project: Optional[str] = None
    purpose: Optional[str] = None


class MaterialIssueResponse(BaseModel):
    id: int
    material_id: int
    issued_to: str
    quantity: float
    project: Optional[str] = None
    purpose: Optional[str] = None
    issued_at: datetime

    class Config:
        from_attributes = True

class AttachmentResponse(BaseModel):
    id: int
    transaction_type: str
    transaction_id: int

    original_filename: str
    content_type: str

    uploaded_at: datetime

    class Config:
        from_attributes = True


class TableCreate(BaseModel):
    name: str
    kind: str = "consumable"


class TableUpdate(BaseModel):
    name: Optional[str] = None
    kind: Optional[str] = None
    columns: Optional[list[dict]] = None


class TableResponse(BaseModel):
    id: int
    name: str
    kind: str
    columns: Optional[list[dict]] = None

    class Config:
        from_attributes = True

class SettingsUpdate(BaseModel):
    system_name: Optional[str] = None
    admin_name: Optional[str] = None
    accent_color: Optional[str] = None


class SettingsResponse(BaseModel):
    system_name: str
    admin_name: str = ""
    accent_color: str