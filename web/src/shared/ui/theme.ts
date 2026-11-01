import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Combobox,
  createTheme,
  Modal,
  MultiSelect,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  Textarea,
  TextInput,
} from '@mantine/core'

const fontFamily = '"SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

const inputStyles = {
  input: {
    backgroundColor: 'var(--fc-surface)',
    borderColor: 'var(--fc-border)',
    color: 'var(--fc-text)',
    fontSize: '13px',
  },
  label: {
    color: 'var(--fc-text-muted)',
    fontSize: '12px',
    fontWeight: 500,
    marginBottom: '5px',
  },
  description: {
    color: 'var(--fc-text-subtle)',
    fontSize: '11px',
  },
}

const dropdownClassNames = {
  dropdown: 'app-select-dropdown',
  options: 'app-select-options',
  option: 'app-select-option',
  search: 'app-select-search',
  empty: 'app-select-empty',
  groupLabel: 'app-select-group-label',
  header: 'app-select-header',
  footer: 'app-select-footer',
}

const selectDefaultProps = {
  radius: 'md',
  size: 'sm',
  withCheckIcon: true,
  checkIconPosition: 'right' as const,
  maxDropdownHeight: 320,
  nothingFoundMessage: '没有匹配的选项',
  comboboxProps: {
    withinPortal: true,
    offset: 6,
    transitionProps: { transition: 'fade' as const, duration: 120 },
  },
  scrollAreaProps: { type: 'auto' as const, scrollbarSize: 5 },
}

// Keep input colors in CSS so compact canvas controls can share the popup
// styling without inheriting an inline minimum height from regular forms.
const selectStyles = { label: inputStyles.label, description: inputStyles.description }

export const theme = createTheme({
  fontFamily,
  headings: {
    fontFamily,
    fontWeight: '600',
  },
  fontSizes: {
    xs: '12px',
    sm: '13px',
    md: '14px',
    lg: '16px',
    xl: '20px',
  },
  radius: {
    xs: '4px',
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '20px',
  },
  defaultRadius: 'sm',
  autoContrast: true,
  primaryColor: 'studio',
  primaryShade: { light: 7, dark: 5 },
  colors: {
    studio: ['#edf6ff', '#d8ebff', '#b9dcff', '#93c8ff', '#6ab4ff', '#409eff', '#318ce7', '#337ecc', '#216bb6', '#18548f'],
    teal: [
      '#ecf8f5',
      '#d4eee7',
      '#b1dccf',
      '#82c3b1',
      '#56a58f',
      '#368b78',
      '#287c6e',
      '#206b5d',
      '#195448',
      '#143f37',
    ],
    gray: [
      '#fafafa',
      '#ededed',
      '#dedede',
      '#c9c9c9',
      '#a9a9a9',
      '#858585',
      '#666666',
      '#484848',
      '#303030',
      '#202020',
    ],
  },
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: { radius: 'sm', variant: 'subtle' },
      styles: { root: { transition: 'background-color 150ms, color 150ms' } },
    }),
    Badge: Badge.extend({
      defaultProps: { radius: 'xs', variant: 'light', size: 'sm' },
      styles: { root: { fontWeight: 500, textTransform: 'none' } },
    }),
    Button: Button.extend({
      defaultProps: { radius: 'md', size: 'sm' },
      vars: (_theme, props) => !props.color || props.color === 'studio' ? {
        root: props.variant === 'filled' || !props.variant ? {
          '--button-bg': 'var(--fc-action)',
          '--button-hover': 'var(--fc-action-hover)',
          '--button-color': 'var(--fc-on-action)',
        } : {},
      } : { root: {} },
      styles: {
        root: { fontWeight: 500, transition: 'background-color 150ms, border-color 150ms, color 150ms' },
        label: { whiteSpace: 'nowrap' },
      },
    }),
    Checkbox: Checkbox.extend({
      defaultProps: { color: 'studio', size: 'sm', radius: 'sm' },
      vars: (_theme, props) => !props.color || props.color === 'studio' ? {
        root: {
          '--checkbox-color': 'var(--fc-primary)',
          ...(!props.iconColor && props.variant !== 'outline' ? { '--checkbox-icon-color': 'var(--fc-on-primary)' } : {}),
        },
      } : { root: {} },
    }),
    Combobox: Combobox.extend({
      defaultProps: { radius: 12, dropdownPadding: 6, offset: 6 },
      classNames: dropdownClassNames,
    }),
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        radius: 'lg',
        overlayProps: { backgroundOpacity: 0.45, blur: 4 },
        transitionProps: { transition: 'fade', duration: 140 },
      },
      styles: {
        content: { border: '1px solid var(--fc-border-soft)', boxShadow: 'var(--fc-modal-shadow)' },
        header: { borderBottom: '1px solid var(--fc-border-soft)', padding: '18px 20px' },
        title: { color: 'var(--fc-text)', fontSize: '16px', fontWeight: 600 },
      },
    }),
    NumberInput: NumberInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
    PasswordInput: PasswordInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { radius: 'md', size: 'sm' },
      styles: {
        root: { backgroundColor: 'var(--fc-surface-muted)', border: '1px solid var(--fc-border-soft)' },
        indicator: { backgroundColor: 'var(--fc-primary-soft)', boxShadow: 'none' },
        label: { fontWeight: 500 },
      },
    }),
    Select: Select.extend({
      defaultProps: selectDefaultProps,
      classNames: { ...dropdownClassNames, input: 'app-select-input', section: 'app-select-section' },
      styles: selectStyles,
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: selectDefaultProps,
      classNames: {
        ...dropdownClassNames,
        input: 'app-select-input app-multiselect-input',
        inputField: 'app-select-input-field',
        section: 'app-select-section',
        pill: 'app-select-pill',
      },
      styles: selectStyles,
    }),
    Switch: Switch.extend({ defaultProps: { color: 'var(--fc-switch-on)', size: 'sm', withThumbIndicator: false } }),
    Tabs: Tabs.extend({ defaultProps: { color: 'studio' }, styles: { tabLabel: { fontWeight: 500 } } }),
    Textarea: Textarea.extend({ defaultProps: { radius: 'sm', size: 'sm', autosize: false }, styles: inputStyles }),
    TextInput: TextInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
  },
})
