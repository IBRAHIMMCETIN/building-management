/**
 * Guvenlik kapisi: arac plakalari, misafir gecisleri (QR + kisa kod), kurye kayitlari ve kapi
 * gunlugu. Tek tablo, `PK = APT#<apartmentId>` (apartman JWT claim'inden):
 *
 *   VEH#<vehicleId>                        arac kaydi (surumlu; silinmez, `inactive` olur). Her aracin
 *                                          sahibi (`ownerUserId`, bolumde oturan uye) vardir: sahibi
 *                                          dairede oturmuyorsa gorevliye pasif gorunur
 *   VEHSLOT#<unitId>                       daire basina arac sinir kilidi (surumlu; es zamanli eklemede
 *                                          yalnizca biri kazanir)
 *   VEHU#<unitId>#<vehicleId>              daire -> arac isaretcisi (yalnizca eklenir)
 *   VPLATE#<ters plaka>                    plaka basina guncel kayit (bolum, durum, not). Ters yazim
 *                                          sondan eslesmeyi `begins_with` sorgusuna cevirir; aktif
 *                                          plaka apartmanda tekildir (kosullu yazim)
 *   GPASS#<passId>                         misafir gecisi (surumlu)
 *   GPU#<unitId>#<passId>                  daire -> gecis isaretcisi
 *   GPTOK#<sha256(token)>                  QR jetonu dizini (TTL: gecerlilik + 7 gun)
 *   GPCODE#<sha256(apartman:kod)>          kisa kod dizini (TTL ayni). Jeton ve kod hicbir kayitta acik
 *                                          tutulmaz; gecis kaydi yalnizca ozetleri tasir, yenilenince
 *                                          eski dizin kaydi ozet uyusmadigi icin calismaz
 *   GCOUR#<courierId>                      kurye kaydi (surumlu)
 *   GCU#<unitId>#<courierId>               daire -> kurye isaretcisi
 *   GLOG#<at>#<logId>                      kapi gunlugu (append-only, SILINMEZ, TTL yok)
 *   GLOGU#<unitId>#<at>#<logId>            daire kopyasi (sakin yalnizca kendi dairesini okur)
 *   GIDEM#<idempotencyKey>                 olusturma / giris-cikis idempotency kaydi
 *
 * Hicbir kayit silinmez (API Lambda'sinin DeleteItem yetkisi yok); iptal, kullanildi, pasif birer
 * durumdur. QR yalnizca rastgele jeton tasir; kisisel veri icermez.
 */
import type { IsoDate, IsoDateTime, TableKeys } from '../core/types.js';

/** Daire basina en fazla aktif arac. */
export const MAX_VEHICLES_PER_UNIT = 4;
/** Misafir gecisinin en uzun gecerlilik araligi (gun, iki uc dahil). */
export const MAX_PASS_DAYS = 31;
/** Gecis en fazla bu kadar gun sonrasi icin olusturulabilir. */
export const MAX_PASS_LEAD_DAYS = 90;
/** Kuryeye bu kadar dakika icinde yanit verilmezse istek dusur (yanit verilemez). */
export const COURIER_RESPONSE_MINUTES = 60;
/** Sakin onayi bu kadar dakika gecerli; sonra kurye iceri alinamaz (yeniden kayit gerekir). */
export const COURIER_APPROVAL_VALID_MINUTES = 120;
/** Jeton / kisa kod dizini gecerlilik bitiminden bu kadar gun sonra (TTL) kendiliginden duser. */
export const PASS_INDEX_GRACE_DAYS = 7;
/** Plaka aramasi: sondan eslesmede en az karakter ve en fazla sonuc. */
export const PLATE_SEARCH_MIN = 3;
export const PLATE_SEARCH_LIMIT = 10;

export type VehicleStatus = 'active' | 'inactive';

export type Vehicle = TableKeys & {
  entityType: 'GATE_VEHICLE';
  apartmentId: string;
  vehicleId: string;
  unitId: string;
  /** Normalize plaka (`34ABC123`). */
  plate: string;
  /** Gorevlinin gordugu kisa not (renk / marka); kisisel veri yazilmamali. */
  note?: string;
  status: VehicleStatus;
  /**
   * Aracin sahibi: bolumde oturan uye (sakin kendisi ya da yoneticinin sectigi). Sahip tasininca arac
   * gorevliye pasif gorunur ve sinira sayilmaz. Alan yoksa (eski kayit) sahibi tasinmis sayilir.
   */
  ownerUserId?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  createdByRole: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

/** Daire basina arac siniri kilidi: her ekleme / etkinlestirme surum kosuluyla yazar. */
export type VehicleSlot = TableKeys & { entityType: 'GATE_VEHICLE_SLOT'; apartmentId: string; unitId: string; version: number; updatedAt: IsoDateTime };

/** Plaka basina guncel durum (gorevli sorgusu tek Query ile buradan okur). */
export type PlateIndex = TableKeys & {
  entityType: 'GATE_PLATE';
  apartmentId: string;
  plate: string;
  vehicleId: string;
  unitId: string;
  status: VehicleStatus;
  ownerUserId?: string;
  note?: string;
  updatedAt: IsoDateTime;
};

export type EntryMode = 'single' | 'multi';
export type PassStatus = 'active' | 'used' | 'revoked';
/** Okuma anindaki karar: `expired` / `not_yet_valid` tarihten turetilir, saklanmaz. */
export type PassVerdict = 'valid' | 'not_yet_valid' | 'expired' | 'used' | 'revoked' | 'host_left';

export type GuestPass = TableKeys & {
  entityType: 'GATE_PASS';
  apartmentId: string;
  passId: string;
  unitId: string;
  guestName: string;
  /** Gecerlilik (Istanbul takvim gunu, iki uc dahil). */
  validFrom: IsoDate;
  validUntil: IsoDate;
  entryMode: EntryMode;
  plate?: string;
  /** Gorevlinin gordugu not. */
  note?: string;
  status: PassStatus;
  /** QR jetonunun ozeti (jetonun kendisi yalnizca olusturma / yenileme yanitinda doner). */
  tokenHash: string;
  /** Kisa kodun (8 karakter) tuzlu ozeti. */
  codeHash: string;
  entryCount: number;
  /** Iceride mi (son kayit giris). */
  inside: boolean;
  lastEntryAt?: IsoDateTime;
  lastExitAt?: IsoDateTime;
  revokedAt?: IsoDateTime;
  revokedBy?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  createdByRole: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export type PassTokenIndex = TableKeys & { entityType: 'GATE_PASS_TOKEN'; apartmentId: string; passId: string; ttl: number };
export type PassCodeIndex = TableKeys & { entityType: 'GATE_PASS_CODE'; apartmentId: string; passId: string; ttl: number };

export type CourierStatus = 'waiting' | 'approved' | 'declined' | 'cancelled';

export type Courier = TableKeys & {
  entityType: 'GATE_COURIER';
  apartmentId: string;
  courierId: string;
  unitId: string;
  /** Kargo / yemek firmasi (serbest metin). */
  company?: string;
  note?: string;
  status: CourierStatus;
  respondedAt?: IsoDateTime;
  respondedBy?: string;
  responseNote?: string;
  enteredAt?: IsoDateTime;
  exitedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  createdBy: string;
  createdByRole: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

/** Daire -> kayit isaretcisi (yalnizca eklenir). */
export type UnitPointer = TableKeys & { entityType: 'GATE_UNIT_POINTER'; apartmentId: string; unitId: string; refId: string; createdAt: IsoDateTime };

export const GATE_LOG_KINDS = ['guest', 'courier', 'manual'] as const;
export type GateLogKind = (typeof GATE_LOG_KINDS)[number];
export type GateDirection = 'entry' | 'exit';

export type GateLogEntry = TableKeys & {
  entityType: 'GATE_LOG' | 'GATE_LOG_UNIT';
  apartmentId: string;
  logId: string;
  at: IsoDateTime;
  direction: GateDirection;
  kind: GateLogKind;
  unitId?: string;
  passId?: string;
  courierId?: string;
  /** Misafir adi (gecis) veya elle girilen ziyaretci adi. */
  visitorName?: string;
  company?: string;
  plate?: string;
  note?: string;
  recordedBy: string;
  recordedByRole: string;
};

export type GateIdempotency = TableKeys & {
  entityType: 'GATE_IDEMPOTENCY';
  apartmentId: string;
  /** Kaydin turu ve kimligi (tekrarda ayni yanit). */
  kind: 'pass' | 'courier' | 'log' | 'entry' | 'exit';
  refId: string;
  logId?: string;
  fingerprint: string;
  createdAt: IsoDateTime;
};

const pk = (apartmentId: string) => `APT#${apartmentId}`;

export const gateKeys = {
  vehicle: (apt: string, id: string): TableKeys => ({ PK: pk(apt), SK: `VEH#${id}` }),
  vehicleUnit: (apt: string, unitId: string, id: string): TableKeys => ({ PK: pk(apt), SK: `VEHU#${unitId}#${id}` }),
  vehicleUnitPrefix: (unitId: string) => `VEHU#${unitId}#`,
  vehicleSlot: (apt: string, unitId: string): TableKeys => ({ PK: pk(apt), SK: `VEHSLOT#${unitId}` }),
  plate: (apt: string, reversedPlate: string): TableKeys => ({ PK: pk(apt), SK: `VPLATE#${reversedPlate}` }),
  platePrefix: 'VPLATE#',
  pass: (apt: string, id: string): TableKeys => ({ PK: pk(apt), SK: `GPASS#${id}` }),
  passUnit: (apt: string, unitId: string, id: string): TableKeys => ({ PK: pk(apt), SK: `GPU#${unitId}#${id}` }),
  passUnitPrefix: (unitId: string) => `GPU#${unitId}#`,
  passToken: (apt: string, tokenHash: string): TableKeys => ({ PK: pk(apt), SK: `GPTOK#${tokenHash}` }),
  passCode: (apt: string, codeHash: string): TableKeys => ({ PK: pk(apt), SK: `GPCODE#${codeHash}` }),
  courier: (apt: string, id: string): TableKeys => ({ PK: pk(apt), SK: `GCOUR#${id}` }),
  courierUnit: (apt: string, unitId: string, id: string): TableKeys => ({ PK: pk(apt), SK: `GCU#${unitId}#${id}` }),
  courierUnitPrefix: (unitId: string) => `GCU#${unitId}#`,
  log: (apt: string, at: IsoDateTime, logId: string): TableKeys => ({ PK: pk(apt), SK: `GLOG#${at}#${logId}` }),
  logUnit: (apt: string, unitId: string, at: IsoDateTime, logId: string): TableKeys => ({ PK: pk(apt), SK: `GLOGU#${unitId}#${at}#${logId}` }),
  logPrefix: 'GLOG#',
  logUnitPrefix: (unitId: string) => `GLOGU#${unitId}#`,
  idempotency: (apt: string, key: string): TableKeys => ({ PK: pk(apt), SK: `GIDEM#${key}` }),
};
