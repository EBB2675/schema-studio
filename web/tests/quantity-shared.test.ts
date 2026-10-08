import { describe, expect, it } from 'vitest';
import { NOMAD_EDIT_RULES, dtypeNameFor, parseEditRules, subsectionName } from '../src/components/quantityShared';

describe('edit rules', () => {
  it('maps what the graph shows back to an editable type', () => {
    expect(dtypeNameFor(NOMAD_EDIT_RULES, 'm_float64(float64)')).toBe('float64');
    expect(dtypeNameFor(NOMAD_EDIT_RULES, 'm_float64(float)')).toBe('float');
    expect(dtypeNameFor(NOMAD_EDIT_RULES, 'Datetime')).toBe('datetime');
    // Not editable as a type: the form keeps the current one.
    expect(dtypeNameFor(NOMAD_EDIT_RULES, 'Reference[main.Part]')).toBe('');
    expect(dtypeNameFor(NOMAD_EDIT_RULES, null)).toBe('');
  });

  it('reads the rules a profile sends', () => {
    const rules = parseEditRules({
      name: 'bam-masterdata',
      codes: true,
      term_code_limit: 50,
      dtypes: [{ name: 'VARCHAR', display: 'VARCHAR' }, { name: 'OBJECT', display: 'OBJECT', needs_range: true }],
    });
    expect(rules?.codes).toBe(true);
    expect(rules?.dtypes.map((d) => d.needs_range)).toEqual([false, true]);
    expect(dtypeNameFor(rules!, 'OBJECT[PERSON.BAM]')).toBe('OBJECT');
    expect(parseEditRules({ dtypes: [] })).toBeUndefined();
  });

  it('names a subsection after its class', () => {
    expect(subsectionName('MyThing')).toBe('my_thing');
    expect(subsectionName('XRDResult')).toBe('xrd_result');
  });
});
