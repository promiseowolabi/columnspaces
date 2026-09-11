//! The browser and these tests run the same five checks (see src/lib.rs).

use parquet_reader as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(footer_parse, lab::check_footer_parse());
lab_test!(rowgroup_metadata, lab::check_rowgroup_metadata());
lab_test!(projection_reads_minimum, lab::check_projection_reads_minimum());
lab_test!(rejects_malformed, lab::check_rejects_malformed());
lab_test!(storm, lab::check_storm());
