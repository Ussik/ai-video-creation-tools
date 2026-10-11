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
    fontWeight: 650,
    marginBottom: '6px',
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
    fontWeight: '700',
  },
  fontSizes: {
    xs: '12px',
    sm: '13px',
    md: '14px',
    lg: '16px',
    xl: '20px',
  },
  radius: {
    xs: '3px',
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
  },
  defaultRadius: 'sm',
  autoContrast: true,
  primaryColor: 'studio',
  primaryShade: { light: 9, dark: 6 },
  colors: {
    studio: ['#fafaf8', '#f3f3f0', '#ededeb', '#e8e9e6', '#e4e6e3', '#e1e3df', '#e8e9e6', '#cbd0c9', '#a8b0a5', '#303943'],
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
      styles: { root: { fontWeight: 650, textTransform: 'none' } },
    }),
    Button: Button.extend({
      defaultProps: { radius: 'md', size: 'sm' },
      vars: (_theme, props) => !props.color || props.color === 'studio' ? {
        root: props.variant === 'filled' || !props.variant ? {
          '--button-bg': 'var(--fc-primary)',
          '--button-hover': 'var(--fc-primary-hover)',
          '--button-color': 'var(--fc-on-primary)',
        } : {},
      } : { root: {} },
      styles: {
        root: { fontWeight: 650, transition: 'background-color 150ms, border-color 150ms, color 150ms' },
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
        radius: 'md',
        overlayProps: { backgroundOpacity: 0.65, blur: 3 },
        transitionProps: { transition: 'fade', duration: 140 },
      },
      styles: {
        content: { border: '1px solid var(--fc-border)', boxShadow: '0 22px 70px rgba(0, 0, 0, 0.48)' },
        header: { borderBottom: '1px solid var(--fc-border-soft)', paddingBottom: '14px' },
        title: { color: 'var(--fc-text)', fontSize: '16px', fontWeight: 700 },
      },
    }),
    NumberInput: NumberInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
    PasswordInput: PasswordInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { radius: 'md', size: 'sm' },
      styles: {
        root: { backgroundColor: 'var(--fc-surface-muted)', border: '1px solid var(--fc-border)' },
        indicator: { boxShadow: '0 1px 3px rgba(0, 0, 0, 0.22)' },
        label: { fontWeight: 620 },
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
    Tabs: Tabs.extend({ defaultProps: { color: 'studio' }, styles: { tabLabel: { fontWeight: 630 } } }),
    Textarea: Textarea.extend({ defaultProps: { radius: 'sm', size: 'sm', autosize: false }, styles: inputStyles }),
    TextInput: TextInput.extend({ defaultProps: { radius: 'sm', size: 'sm' }, styles: inputStyles }),
  },
})
