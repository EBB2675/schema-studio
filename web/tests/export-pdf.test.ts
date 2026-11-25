import { beforeEach, describe, expect, it, vi } from 'vitest';
import { savePngPdf } from '../src/utils/exportPdf';

const { pdf, construct } = vi.hoisted(() => ({
  pdf: {
    internal: { pageSize: { getWidth: () => 800, getHeight: () => 600 } },
    getImageProperties: vi.fn(), addImage: vi.fn(), save: vi.fn(),
  },
  construct: vi.fn(),
}));
vi.mock('jspdf', () => ({ jsPDF: class { constructor(options: unknown) { construct(options); return pdf; } } }));
beforeEach(() => { vi.resetAllMocks(); });

describe('PDF export', () => {
  it.each([
    { width: 1600, height: 600, expected: [0, 150, 800, 300] },
    { width: 400, height: 1200, expected: [300, 0, 200, 600] },
  ])('fits and centers a $width × $height diagram', async ({ width, height, expected }) => {
    pdf.getImageProperties.mockReturnValue({ width, height });
    savePngPdf('png', 'schema.pdf');
    expect(construct).toHaveBeenCalledWith({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    expect(pdf.addImage).toHaveBeenCalledWith('png', 'PNG', ...expected);
    expect(pdf.save).toHaveBeenCalledWith('schema.pdf');
  });

  it('propagates PDF save failures to the UI', async () => {
    pdf.getImageProperties.mockReturnValue({ width: 800, height: 600 });
    pdf.save.mockImplementation(() => { throw new Error('Save failed'); });
    expect(() => savePngPdf('png', 'schema.pdf')).toThrow('Save failed');
  });
});
