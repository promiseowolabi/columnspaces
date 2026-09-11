//! The browser and these tests run the same six checks (see src/lib.rs).

use merge_on_read as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(read_your_writes, lab::check_read_your_writes());
lab_test!(merge_ordered, lab::check_merge_ordered());
lab_test!(delete_semantics, lab::check_delete_semantics());
lab_test!(read_amp_bounded, lab::check_read_amp_bounded());
lab_test!(write_amp_budget, lab::check_write_amp_budget());
lab_test!(storm, lab::check_storm());
