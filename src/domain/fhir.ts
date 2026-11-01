/**
 * Minimal FHIR R4 resource types used by Steadyline.
 * Only the subset of elements the app reads or writes is modelled.
 * Spec: https://hl7.org/fhir/R4/
 */

export interface Coding {
  system?: string;
  code: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Quantity {
  value: number;
  unit: string;
  /** UCUM system URL */
  system?: string;
  code?: string;
}

export interface Reference {
  reference: string;
  display?: string;
}

export interface Period {
  start?: string;
  end?: string;
}

export interface Patient {
  resourceType: 'Patient';
  id: string;
  name?: { text: string }[];
  birthDate?: string;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  /** Marks synthetic demo data. Stored as a FHIR meta tag. */
  meta?: { tag?: Coding[] };
}

export interface Condition {
  resourceType: 'Condition';
  id: string;
  subject: Reference;
  code: CodeableConcept;
  clinicalStatus?: CodeableConcept;
  onsetDateTime?: string;
}

export interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: Quantity;
  valueInteger?: number;
}

export interface Observation {
  resourceType: 'Observation';
  id: string;
  status: 'final' | 'preliminary' | 'amended';
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject: Reference;
  effectiveDateTime: string;
  valueQuantity?: Quantity;
  valueInteger?: number;
  valueString?: string;
  component?: ObservationComponent[];
  bodySite?: CodeableConcept;
  note?: { text: string }[];
}

export interface Dosage {
  text?: string;
  timing?: {
    repeat?: { timeOfDay?: string[]; frequency?: number; period?: number; periodUnit?: string };
  };
}

export interface MedicationStatement {
  resourceType: 'MedicationStatement';
  id: string;
  status: 'active' | 'completed' | 'stopped' | 'on-hold';
  medicationCodeableConcept: CodeableConcept;
  subject: Reference;
  effectivePeriod?: Period;
  dosage?: Dosage[];
}

export interface MedicationAdministration {
  resourceType: 'MedicationAdministration';
  id: string;
  /** `completed` = taken, `not-done` = missed/skipped */
  status: 'completed' | 'not-done';
  medicationCodeableConcept: CodeableConcept;
  subject: Reference;
  effectiveDateTime: string;
  /** Scheduled time this entry answers to, if any. */
  supportingInformation?: Reference[];
}

export type Resource =
  Patient | Condition | Observation | MedicationStatement | MedicationAdministration;

export type ResourceType = Resource['resourceType'];

export interface BundleEntry {
  fullUrl?: string;
  resource: Resource;
}

export interface Bundle {
  resourceType: 'Bundle';
  type: 'collection' | 'transaction' | 'document';
  timestamp?: string;
  entry: BundleEntry[];
}
