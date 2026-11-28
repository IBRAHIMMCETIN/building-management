import { fireEvent, render, screen } from '@testing-library/react-native';
import { ChipGroup } from './ChipGroup';

const options = [
  { value: 'a', label: 'Açık' },
  { value: 'b', label: 'Kapanan' },
  { value: 'c', label: 'Tümü' },
] as const;

const key = (k: string) => ({ nativeEvent: { key: k }, preventDefault: jest.fn() });

describe('ChipGroup', () => {
  it('radyo grubu: secili oge yalnizca checked (radyoda selected / aria-selected yok)', async () => {
    await render(<ChipGroup label="Durum" value="b" options={options} onChange={jest.fn()} />);
    expect(screen.getByLabelText('Durum').props.accessibilityRole).toBe('radiogroup');
    const state = screen.getByRole('radio', { name: 'Kapanan' }).props.accessibilityState;
    expect(state).toEqual({ checked: true, disabled: false });
    expect(screen.getByRole('radio', { name: 'Açık', checked: false })).toBeTruthy();
  });

  it('klavye: oklar sonraki / onceki secenegi secer (basa / sona sarar), Space ve Enter secer', async () => {
    const onChange = jest.fn();
    await render(<ChipGroup label="Durum" value="a" options={options} onChange={onChange} />);
    await fireEvent(screen.getByRole('radio', { name: 'Açık' }), 'keyDown', key('ArrowRight'));
    expect(onChange).toHaveBeenLastCalledWith('b');
    await fireEvent(screen.getByRole('radio', { name: 'Açık' }), 'keyDown', key('ArrowLeft'));
    expect(onChange).toHaveBeenLastCalledWith('c');
    await fireEvent(screen.getByRole('radio', { name: 'Tümü' }), 'keyDown', key('ArrowDown'));
    expect(onChange).toHaveBeenLastCalledWith('a');
    await fireEvent(screen.getByRole('radio', { name: 'Kapanan' }), 'keyDown', key(' '));
    expect(onChange).toHaveBeenLastCalledWith('b');
    await fireEvent(screen.getByRole('radio', { name: 'Tümü' }), 'keyDown', { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    onChange.mockClear();
    await fireEvent(screen.getByRole('radio', { name: 'Tümü' }), 'keyDown', key('a'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('devre disi grup klavyeye ve dokunmaya tepki vermez', async () => {
    const onChange = jest.fn();
    await render(<ChipGroup label="Durum" value="a" options={options} onChange={onChange} disabled />);
    await fireEvent(screen.getByRole('radio', { name: 'Açık' }), 'keyDown', key('ArrowRight'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Kapanan' }).props.accessibilityState).toEqual({ checked: false, disabled: true });
  });
});
